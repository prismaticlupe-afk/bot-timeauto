try { require('dotenv').config(); } catch (e) {}

const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
    TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
    UserSelectMenuBuilder, PermissionsBitField, ActivityType, AttachmentBuilder
} = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const axios = require('axios');

const dbURI = process.env.MONGO_URI;
if (!dbURI) {
    console.error("❌ ERROR CRÍTICO: Falta la variable MONGO_URI en el archivo .env o en la configuración.");
    process.exit(1);
}

mongoose.connect(dbURI)
    .then(() => console.log('🗄️ Base de Datos V19 (Final) Conectada.'))
    .catch(err => {
        console.error('❌ Error conectando a MongoDB:', err);
        process.exit(1);
    });


const GuildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    mode: { type: Number, default: 2 }, 
    dashChannelId: String, 
    supervisorChannelId: String, 
    logChannelId: String, 
    configChannelId: String,
    timezone: String,
    adminRoles: [String],
    rolePermissions: [{ takerRoleId: String, targetRoleIds: [String] }],
    autoCut: { day: String, time: String },
    isFrozen: { type: Boolean, default: false },
    liveDashboardMsgId: String,
    supervisorDashboardMsgId: String
});
const GuildConfig = mongoose.model('GuildConfig', GuildConfigSchema);

const WorkSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    startedBy: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, default: null },
    isPaused: { type: Boolean, default: false },
    pauseStartTime: Date,
    totalPausedMs: { type: Number, default: 0 },
    manualAdjustmentMs: { type: Number, default: 0 }
});
const WorkSession = mongoose.model('WorkSession', WorkSessionSchema);

const UserStateSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    isBanned: { type: Boolean, default: false },
    penaltyUntil: { type: Date, default: null }
});
UserStateSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const UserState = mongoose.model('UserState', UserStateSchema);

const app = express();
app.get('/', (req, res) => res.send('Bot Tiempillo V19 Activo.'));
app.get('/ping', (req, res) => res.status(200).send('Pong!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    presence: { status: 'online', activities: [{ name: '!guia | Tiempillo', type: ActivityType.Watching }] }
});

const rateLimits = new Map();
const SPAM_COOLDOWN = 3000;
const setupCache = new Map();

const TIMEZONES = [
    { label: '🇲🇽 México (Centro)', value: 'America/Mexico_City' },
    { label: '🇨🇴/🇵🇪 Colombia/Perú', value: 'America/Bogota' },
    { label: '🇦🇷/🇨🇱 Argentina/Chile', value: 'America/Argentina/Buenos_Aires' },
    { label: '🇪🇸 España', value: 'Europe/Madrid' },
    { label: '🇺🇸 USA (New York)', value: 'America/New_York' }
];

function isRateLimited(userId) {
    const now = Date.now();
    const last = rateLimits.get(userId);
    if (last && (now - last < SPAM_COOLDOWN)) return true;
    rateLimits.set(userId, now);
    return false;
}

async function isAdmin(interactionMember, guildId) {
    const config = await GuildConfig.findOne({ guildId: guildId });
    if (!config) return false;
    return interactionMember.roles.cache.some(r => config.adminRoles.includes(r.id)) || interactionMember.id === interactionMember.guild.ownerId;
}

function calculateDuration(session, referenceEndDate = new Date()) {
    const endPoint = session.endTime || referenceEndDate;
    let totalElapsed = endPoint - session.startTime;
    let currentPauseDuration = 0;
    if (session.isPaused && session.pauseStartTime && !session.endTime) {
        currentPauseDuration = referenceEndDate - session.pauseStartTime;
    }
    return totalElapsed - session.totalPausedMs - currentPauseDuration + (session.manualAdjustmentMs || 0);
}

function getHabboHeadUrl(username) {
    return `https://www.habbo.es/habbo-imaging/avatarimage?user=${encodeURIComponent(username)}&direction=2&head_direction=2&action=&gesture=nrm&size=s&headonly=1`;
}

async function generateHistoryPDF(userId, guildId, username, sessions, timezone, guild) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            const primaryColor = '#2c3e50'; 
            const secondaryColor = '#7f8c8d'; 
            const headerBg = '#ecf0f1'; 

            try {
                const imgRes = await axios.get(getHabboHeadUrl(username), { responseType: 'arraybuffer', timeout: 1500 });
                doc.image(imgRes.data, (doc.page.width / 2) - 20, 30, { width: 40 });
            } catch (e) {}

            doc.moveDown(3);
            
            doc.font('Helvetica-Bold').fontSize(22).fillColor(primaryColor)
               .text(`AGENCIA ${guild.name.toUpperCase()}`, { align: 'center' });
            
            doc.font('Helvetica-Oblique').fontSize(10).fillColor(secondaryColor)
               .text('Sistema de historial de tiempo acumulado', { align: 'center' });
            
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(12).fillColor('black')
               .text(`Reporte de Asistencia: ${username}`, { align: 'center' });
            doc.fontSize(10).text(`Generado: ${moment().format('DD/MM/YYYY HH:mm')}`, { align: 'center' });
            
            doc.moveDown(2);

            const startX = 40; 
            let currentY = doc.y;
            const colWidths = { fecha: 60, inicio: 50, fin: 50, dur: 70, tipo: 130, status: 60, avatar: 40 };
            
            doc.rect(startX, currentY, 520, 20).fill(headerBg);
            doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
            let cx = startX + 5;
            doc.text('FECHA', cx, currentY + 5); cx += colWidths.fecha;
            doc.text('INICIO', cx, currentY + 5); cx += colWidths.inicio;
            doc.text('FIN', cx, currentY + 5); cx += colWidths.fin;
            doc.text('DURACIÓN', cx, currentY + 5); cx += colWidths.dur;
            doc.text('ENCARGADO', cx, currentY + 5); cx += colWidths.tipo;
            doc.text('ESTADO', cx, currentY + 5); cx += colWidths.status;
            doc.text('AVATAR', cx, currentY + 5);

            currentY += 25; 
            doc.font('Helvetica').fontSize(9);

            let totalMs = 0;

            for(const s of sessions) {
                if (currentY > 750) { doc.addPage(); currentY = 50; }
                
                const dur = calculateDuration(s); 
                totalMs += dur;
                const tz = timezone || 'UTC';
                
                let initiatorName = "Auto-Servicio";
                let initiatorAvatarUrl = null;

                if (s.startedBy !== s.userId) {
                    if(guild) {
                        const sup = await guild.members.fetch(s.startedBy).catch(()=>null);
                        initiatorName = sup ? sup.displayName : `ID: ${s.startedBy}`;
                    } else initiatorName = s.startedBy;
                    initiatorAvatarUrl = getHabboHeadUrl(initiatorName);
                } else {
                    initiatorAvatarUrl = getHabboHeadUrl(username);
                }

                const dateStr = moment(s.startTime).tz(tz).format('DD/MM/YY');
                const startStr = moment(s.startTime).tz(tz).format('HH:mm');
                const endStr = s.endTime ? moment(s.endTime).tz(tz).format('HH:mm') : '---';
                const durStr = moment.duration(dur).format("h[h] m[m]");
                const statusStr = s.endTime ? 'Cerrado' : 'Activo';

                cx = startX + 5;
                doc.text(dateStr, cx, currentY); cx += colWidths.fecha;
                doc.text(startStr, cx, currentY); cx += colWidths.inicio;
                doc.text(endStr, cx, currentY); cx += colWidths.fin;
                doc.text(durStr, cx, currentY); cx += colWidths.dur;
                doc.text(initiatorName.substring(0, 22), cx, currentY); cx += colWidths.tipo;
                doc.text(statusStr, cx, currentY); cx += colWidths.status;

                if (initiatorAvatarUrl) {
                    try {
                        const headRes = await axios.get(initiatorAvatarUrl, { responseType: 'arraybuffer', timeout: 1000 });
                        doc.image(headRes.data, cx, currentY - 5, { width: 18 });
                    } catch (e) { doc.text('-', cx, currentY); }
                }

                doc.moveTo(startX, currentY + 15).lineTo(560, currentY + 15).lineWidth(0.5).strokeColor('#ecf0f1').stroke();
                doc.strokeColor('black');

                currentY += 20;
            }

            doc.moveDown(2);
            doc.rect(startX, currentY, 200, 30).fill(headerBg);
            doc.fillColor('black').font('Helvetica-Bold').fontSize(14)
               .text(`TOTAL ACUMULADO: ${moment.duration(totalMs).format("h[h] m[m]")}`, startX + 10, currentY + 8);

            doc.end();
        } catch (e) { reject(e); }
    });
}

client.on('ready', () => {
    console.log(`🤖 TIEMPILLO V19 Online: ${client.user.tag}`);
    setInterval(checkAutoSchedules, 60000);
    setInterval(refreshAllLiveDashboards, 30000);
    
    client.guilds.cache.forEach(g => {
        updatePublicDash(g.id);
        updateLiveAdminDash(g.id); 
    });
});

client.on('messageCreate', async (m) => {
    if (m.author.bot) return;

    if (m.content === '!mitiempo') {
        const c = await GuildConfig.findOne({ guildId: m.guild.id });
        if (!c) return m.reply('⚠️ No configurado.');
        m.delete().catch(()=>{}); 
        const ss = await WorkSession.find({ userId: m.author.id, guildId: m.guild.id, endTime: { $ne: null } });
        let t = ss.reduce((a, s) => a + calculateDuration(s), 0);
        const act = await WorkSession.findOne({ userId: m.author.id, guildId: m.guild.id, endTime: null });
        if(act) t += calculateDuration(act); t = Math.max(0, t);
        try { await m.author.send({ embeds: [new EmbedBuilder().setTitle('⏱️ Tu Tiempo').setDescription(`# ${moment.duration(t).format("h[h] m[m]")}`).setColor(0x5865F2)] }); } catch(e){}
    }

    if (m.content === '!guide' || m.content === '!guia') {
        const guiaEmbed = new EmbedBuilder()
            .setTitle('✨ Bienvenido a TIEMPILLO')
            .setDescription('Hola, soy **Tiempillo**, tu asistente profesional para la gestión de nóminas y control de asistencia en tu agencia.\n\nEste sistema permite llevar un registro exacto de las horas trabajadas, gestionar pausas y generar reportes detallados.')
            .setColor(0x00A8FF) // Un azul bonito
            .setThumbnail('https://www.habbo.com/habbo-imaging/avatarimage?figure=hr-890-45-.hd-600-3-.ch-685-77-.lg-705-81-.sh-730-62-.ca-1810-undefined-.wa-2007-undefined-&gender=M&direction=4&head_direction=2&action=wav&gesture=nrm&size=m')
            .addFields(
                { name: '🚀 Primeros Pasos (Configuración)', value: 'Para empezar, el dueño del servidor debe crear los canales necesarios y ejecutar `!run`.\n\n**Canales Requeridos:**\n`#fichar` (Público: Para que todos vean el panel)\n`#logs` (Privado: Panel de control para Admins)\n`#control-tiempos` (Opcional: Si usas modo Supervisor)' },
                { name: '👮 Para Administradores', value: '`!run`: Configura o resetea el bot.\n`!nomina`: Muestra la lista de pagos pendientes y genera **PDFs**.\n`!time @user`: Ver historial detallado, sumar/restar tiempo o borrar datos.\n`!multar @user`: Aplica sanciones temporales.\n`!bantime @user`: Bloquea permanentemente al usuario.' },
                { name: '👥 Para Usuarios / Supervisores', value: '`!mitiempo`: Te envía tu acumulado por mensaje privado.\n`!tomar @user`: Inicia el contador a otro usuario (Solo modo supervisor).' },
                { name: '📄 Sistema de Reportes PDF', value: 'Al usar `!nomina` y seleccionar "Historial", recibirás un documento PDF profesional con el desglose de horas, fechas y los avatares de los encargados.' }
            )
            .setFooter({ text: 'Tiempillo System V19 - Gestión Profesional' });

        m.reply({ embeds: [guiaEmbed] });
    }

    if (m.content.startsWith('!')) {
        const adminCmds = ['!run', '!corte', '!time', '!multar', '!bantime', '!activetime', '!nomina', '!tomar'];
        const cmd = m.content.split(' ')[0]; 
        if (!adminCmds.includes(cmd)) return;
        
        if (cmd === '!tomar') {
            const config = await GuildConfig.findOne({ guildId: m.guild.id });
            if (!config) return m.reply('⚠️ No configurado.');
            if (config.mode !== 2 && config.supervisorChannelId && m.channel.id !== config.supervisorChannelId) return m.reply(`⚠️ Comando exclusivo de <#${config.supervisorChannelId}>.`);
            const target = m.mentions.users.first();
            if (!target) return m.reply('⚠️ Uso: `!tomar @usuario`');

            if (target.id === m.author.id) return m.reply('⛔ No puedes tomarte tiempo a ti mismo en este modo. Debe hacerlo otro supervisor.');

            let canTake = false;
            if (m.member.roles.cache.some(r => config.adminRoles.includes(r.id)) || m.author.id === m.guild.ownerId) canTake = true;
            else if (config.rolePermissions?.length > 0) {
                const takerRoles = m.member.roles.cache.map(r => r.id);
                const targetMember = await m.guild.members.fetch(target.id).catch(()=>null);
                if(!targetMember) return m.reply('Usuario no encontrado.');
                const targetRoles = targetMember.roles.cache.map(r => r.id);
                for (const rule of config.rolePermissions) { if (takerRoles.includes(rule.takerRoleId) && targetRoles.some(r => rule.targetRoleIds.includes(r))) canTake = true; }
            }
            if (!canTake) return m.reply('⛔ Sin rango suficiente.');

            const activeS = await WorkSession.findOne({ userId: target.id, guildId: m.guild.id, endTime: null });
            if (activeS) {
                const starterMember = await m.guild.members.fetch(activeS.startedBy).catch(()=>null);
                return m.reply(`⚠️ Usuario con time activo.\n**Encargado:** ${starterMember ? starterMember.displayName : 'Desconocido'}`);
            }

            await new WorkSession({ userId: target.id, guildId: m.guild.id, startedBy: m.author.id, startTime: new Date() }).save();
            m.reply(`✅ **Tiempo iniciado** para ${target} por ${m.author}.`);
            updateLiveAdminDash(m.guild.id); updatePublicDash(m.guild.id);
            return;
        }

        if(cmd==='!run' && m.author.id!==m.guild.ownerId) return m.reply('❌ Solo el Dueño puede configurar.');
        if(cmd!=='!run' && !(await isAdmin(m.member, m.guild.id))) return m.reply('⛔ Admin.');
        const target = m.mentions.users.first();

        if (cmd === '!nomina') {
            m.delete().catch(()=>{}); 
            const allSessions = await WorkSession.find({ guildId: m.guild.id, endTime: { $ne: null } });
            const totals = {};
            allSessions.forEach(s => { totals[s.userId] = (totals[s.userId] || 0) + calculateDuration(s); });
            const userIds = Object.keys(totals).filter(id => totals[id] > 0).sort((a,b) => totals[b] - totals[a]);
            
            let desc = "**Nómina (Tiempos Acumulados)**\n"; let count = 0;
            for (const uid of userIds) {
                const mem = await m.guild.members.fetch(uid).catch(()=>null);
                const name = mem ? mem.displayName : uid;
                desc += `**${++count}. ${name}**: \`${moment.duration(totals[uid]).format("h[h] m[m]")}\`\n`;
            }
            if(count===0) desc="✅ Todo pagado.";
            
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_nomina_pay').setLabel('Pagar (Reset)').setStyle(3).setEmoji('💸').setDisabled(count===0), new ButtonBuilder().setCustomId('btn_nomina_hist').setLabel('Reporte PDF').setStyle(1).setEmoji('📄').setDisabled(count===0));
            await m.channel.send({ embeds: [new EmbedBuilder().setTitle('💰 Gestión de Nómina').setDescription(desc.substring(0,4000)).setColor(0x2B2D31)], components: [row] });
        }

        if (cmd==='!run') {
            const c = await GuildConfig.findOne({ guildId: m.guild.id });
            if(c) return m.reply({ embeds:[new EmbedBuilder().setTitle('⚠️ Configuración Existente').setDescription('El bot ya tiene datos.\nPara cambiar la configuración, presiona Resetear.').setColor(0xFFA500)], components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_reset_config_confirm').setLabel('🔄 Resetear Configuración').setStyle(4))] });
            
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_mode_select').setPlaceholder('Selecciona el Modo').addOptions(
                { label: 'Usuarios toman time a usuarios', description: 'Requiere configurar jerarquía.', value: '1', emoji: '👮' },
                { label: 'Usuarios se toman times solos', description: 'Sistema de botones públicos.', value: '2', emoji: '🤖' },
                { label: 'Híbrido (Ambos)', value: '3', emoji: '✨' }
            ));
            m.reply({ content: `👋 **Instalación Tiempillo V19**\nElige cómo funcionará el sistema:`, components: [row] });
        }

        if (cmd==='!corte') { const c=await GuildConfig.findOne({guildId:m.guild.id}); const l=await client.channels.fetch(c.logChannelId).catch(()=>null); if(l){await l.send('✂️ CORTE'); m.reply('✅');} }
        if (cmd.startsWith('!multar') && target) { m.reply({content:`Multando...`, components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`menu_penalty_${target.id}`).setPlaceholder('Tiempo').addOptions({label:'10m',value:'10'},{label:'30m',value:'30'},{label:'1h',value:'60'}))], ephemeral:true}); }
        if ((cmd.startsWith('!ban')||cmd.startsWith('!active')) && target) { const b=cmd.startsWith('!ban'); await UserState.findOneAndUpdate({userId:target.id, guildId:m.guild.id}, {isBanned:b, penaltyUntil:null}, {upsert:true}); m.reply(`✅ ${target.tag} **${b?'BANEADO':'ACTIVADO'}**.`); }
        if (cmd.startsWith('!time') && target) {
            const ss = await WorkSession.find({ userId: target.id, guildId: m.guild.id, endTime: { $ne: null } });
            let tot = ss.reduce((a, s) => a + calculateDuration(s), 0);
            const act = await WorkSession.findOne({ userId: target.id, guildId: m.guild.id, endTime: null });
            if(act) tot += calculateDuration(act); tot=Math.max(0,tot);
            const r1 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_time_add_${target.id}`).setLabel('Sumar').setStyle(3).setEmoji('➕'), new ButtonBuilder().setCustomId(`btn_time_sub_${target.id}`).setLabel('Restar').setStyle(2).setEmoji('➖'));
            const r2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_admin_clear_db_${target.id}`).setLabel('BORRAR DB').setStyle(4).setEmoji('🗑️'));
            m.reply({ embeds: [new EmbedBuilder().setTitle(`Reporte: ${target.username}`).setDescription(`Total: **${moment.duration(tot).format("h[h] m[m]")}**`).setColor(0x5865F2)], components: [r1, r2] });
        }
    }
});
client.on('interactionCreate', async (i) => {
    if (i.isButton() && isRateLimited(i.user.id)) return i.reply({ content: '⏳ ...', ephemeral: true });
    const gId = i.guild.id; const uId = i.user.id;

    if (i.isStringSelectMenu() && i.customId === 'setup_mode_select') {
        if (i.user.id !== i.guild.ownerId) return i.reply({ content: '❌ Owner.', ephemeral: true });
        const mode = parseInt(i.values[0]); setupCache.set(gId, { mode: mode, permissions: [] });
        if (mode === 1 || mode === 3) {
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_perm_add').setLabel('Agregar Regla').setStyle(3), new ButtonBuilder().setCustomId('setup_perm_finish').setLabel('Terminar Permisos').setStyle(1));
            await i.update({ content: `✅ Modo ${mode}.\n**Jerarquía:** Define quién toma time a quién.`, components: [row] });
        } else triggerGeneralSetup(i);
    }
    if (i.customId === 'setup_perm_add') {
        const r1 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_perm_taker').setPlaceholder('Supervisor').setMaxValues(1));
        const r2 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_perm_target').setPlaceholder('Objetivos').setMinValues(1));
        const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_perm_save').setLabel('Guardar').setStyle(3));
        await i.reply({ content: 'Nueva Regla:', components: [r1, r2, r3], ephemeral: true });
    }
    if(i.isRoleSelectMenu() && i.customId==='setup_perm_taker') { const c=setupCache.get(uId)||{}; c.tempTaker=i.values[0]; setupCache.set(uId,c); i.deferUpdate(); }
    if(i.isRoleSelectMenu() && i.customId==='setup_perm_target') { const c=setupCache.get(uId)||{}; c.tempTargets=i.values; setupCache.set(uId,c); i.deferUpdate(); }
    if(i.customId === 'setup_perm_save') {
        const cUser = setupCache.get(uId); if(!cUser?.tempTaker || !cUser?.tempTargets) return i.reply({content:'❌ Faltan datos.', ephemeral:true});
        const cGuild = setupCache.get(gId); cGuild.permissions.push({ takerRoleId: cUser.tempTaker, targetRoleIds: cUser.tempTargets });
        setupCache.set(gId, cGuild); setupCache.delete(uId);
        await i.update({ content: '✅ Guardado.', components: [] });
        await i.message.channel.send({ content: `Reglas: ${cGuild.permissions.length}`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_perm_add').setLabel('+ Regla').setStyle(3), new ButtonBuilder().setCustomId('setup_perm_finish').setLabel('Continuar').setStyle(1))] });
    }
    if(i.customId === 'setup_perm_finish') triggerGeneralSetup(i);

    async function triggerGeneralSetup(interaction) {
        const msg = "🔧 **Configuración General**";
        const r = [
            new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_zone').setPlaceholder('Elige la Zona Horaria de tu Bot').addOptions(TIMEZONES)), 
            new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_roles').setPlaceholder('Roles Administradores (Multiselección)').setMinValues(1).setMaxValues(10)), 
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_continue_setup_final').setLabel('Siguiente').setStyle(1))
        ];
        if(interaction.replied||interaction.deferred) await interaction.followUp({content:msg, components:r, ephemeral:true}); else await interaction.update({content:msg, components:r});
    }
    if (i.isStringSelectMenu() && i.customId==='setup_zone'){const c=setupCache.get(gId)||{}; c.timezone=i.values[0]; setupCache.set(gId,c); i.deferUpdate();}
    if (i.isRoleSelectMenu() && i.customId==='setup_roles'){const c=setupCache.get(gId)||{}; c.adminRoles=i.values; setupCache.set(gId,c); i.deferUpdate();}

    if(i.customId === 'btn_continue_setup_final') {
        const c = setupCache.get(gId);
        const m = new ModalBuilder().setCustomId('setup_modal_final').setTitle('Canales y Horarios');
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID Canal LOGS (Privado Admin)").setStyle(1)));
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Corte Automático (Reseteo a 0)").setPlaceholder("Ej: lunes 00:00 (O escribe 'no')").setStyle(1).setRequired(false)));
        if (c.mode !== 1) m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID Canal FICHAR (Público)").setStyle(1)));
        if (c.mode !== 2) m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sup').setLabel("ID Canal Control Tiempos").setStyle(1)));
        await i.showModal(m);
    }
    
    if(i.isModalSubmit() && i.customId === 'setup_modal_final') {
        const c = setupCache.get(gId);
        const logId = i.fields.getTextInputValue('log');
        const autoRaw = i.fields.getTextInputValue('auto');
        let autoCut = null; if (autoRaw?.includes(':') && !autoRaw.toLowerCase().includes('no')) { const p = autoRaw.split(' '); autoCut = { day: p[0], time: p[1] }; }
        let dashId = null, supId = null;
        try { if(c.mode!==1) dashId = i.fields.getTextInputValue('dash'); } catch(e){}
        try { if(c.mode!==2) supId = i.fields.getTextInputValue('sup'); } catch(e){}
        try {
            await GuildConfig.findOneAndUpdate({ guildId: gId }, { mode: c.mode, dashChannelId: dashId, supervisorChannelId: supId, logChannelId: logId, configChannelId: i.channelId, timezone: c.timezone, adminRoles: c.adminRoles, rolePermissions: c.permissions || [], autoCut, isFrozen: false }, { upsert: true, new: true });
            if(dashId) { const ch = await i.guild.channels.fetch(dashId); sendPublicDashboardMsg(ch, gId); }
            const logCh = await i.guild.channels.fetch(logId);
            const m = await logCh.send('Dashboard Admin Iniciado...');
            await GuildConfig.findOneAndUpdate({guildId: gId}, {liveDashboardMsgId: m.id});
            updateLiveAdminDash(gId);
            
            await i.reply({ content: '✅ **Configuración Completada.**', ephemeral: true });
            try { if (i.message) i.message.delete(); } catch(e){}
        } catch(e) { i.reply(`Error: ${e.message}`); }
    }

    if(i.customId === 'btn_sup_take_time') i.reply({ content: 'Selecciona:', components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('menu_sup_select_target').setMaxValues(1))], ephemeral: true });
    if(i.isUserSelectMenu() && i.customId === 'menu_sup_select_target') {
        const targetId = i.values[0]; 
        if (targetId === i.user.id) return i.reply({ content: '⛔ No puedes tomarte tiempo a ti mismo en este modo.', ephemeral: true });

        const c = await GuildConfig.findOne({ guildId: gId }); let can = false;
        if (i.member.roles.cache.some(r => c.adminRoles.includes(r.id)) || i.user.id === i.guild.ownerId) can = true;
        else if (c.rolePermissions?.length) { 
            const tr = i.member.roles.cache.map(r => r.id); 
            const tm = await i.guild.members.fetch(targetId).catch(()=>null); 
            if(tm){ const ttr = tm.roles.cache.map(r => r.id); for (const r of c.rolePermissions) if (tr.includes(r.takerRoleId) && ttr.some(x => r.targetRoleIds.includes(x))) can = true; }
        }
        if (!can) return i.reply({content:'⛔ Sin rango.', ephemeral:true});
        if (await WorkSession.findOne({ userId: targetId, guildId: gId, endTime: null })) return i.reply({content:'❌ Ya activo.', ephemeral:true});
        await new WorkSession({ userId: targetId, guildId: gId, startedBy: i.user.id, startTime: new Date() }).save();
        i.reply({content:`✅ Iniciado para <@${targetId}>.`, ephemeral:true}); updateLiveAdminDash(gId); updatePublicDash(gId);
    }

    if (i.isStringSelectMenu() && i.customId.startsWith('menu_nomina_')) {
        const mode = i.customId.split('_')[2], t = i.values[0];
        if (mode === 'pay') {
            await i.deferUpdate();
            await WorkSession.deleteMany({ userId: t, guildId: gId, endTime: { $ne: null } });
            i.followUp({ content: `✅ Pagado <@${t}>.`, ephemeral: true });
        }
        if (mode === 'hist') {
            await i.deferReply({ ephemeral: true });
            const ss = await WorkSession.find({ userId: t, guildId: gId, endTime: { $ne: null } }).sort({ startTime: 1 });
            if (!ss.length) return i.editReply('Sin historial.');
            const m = await i.guild.members.fetch(t).catch(() => null);
            const c = await GuildConfig.findOne({ guildId: gId });
            try {
                const pdf = await generateHistoryPDF(t, gId, m ? m.displayName : t, ss, c.timezone, i.guild);
                await i.editReply({ content: `📄 **Reporte PDF para ${m ? m.displayName : t}**`, files: [new AttachmentBuilder(pdf, { name: 'Reporte.pdf' })] });
            } catch (error) { await i.editReply('❌ Error PDF.'); }
        }
    }

    if(i.customId==='btn_nomina_pay'||i.customId==='btn_nomina_hist'){
        if(!(await isAdmin(i.member, gId))) return i.reply('⛔');
        const ss = await WorkSession.find({guildId:gId, endTime:{$ne:null}}); const tot={}; ss.forEach(s=>tot[s.userId]=(tot[s.userId]||0)+calculateDuration(s));
        const u = Object.keys(tot).filter(k=>tot[k]>0).slice(0,25); if(!u.length) return i.reply({content:'Nadie pendiente.',ephemeral:true});
        const opts=[]; for(const k of u){const m=await i.guild.members.fetch(k).catch(()=>null); opts.push({label:(m?m.displayName:k).substring(0,25),value:k});}
        const mode = i.customId.split('_')[2];
        i.reply({content:`Selecciona usuario:`, components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`menu_nomina_${mode}`).addOptions(opts))], ephemeral:true});
    }
    if (i.isUserSelectMenu() && i.customId.startsWith('menu_trans_newsup_')) {
        const tId = i.customId.split('_')[3]; const newSupId = i.values[0];
        const oldS = await WorkSession.findOne({ userId: tId, guildId: gId, endTime: null });
        if(!oldS) return i.reply({ content: 'Error.', ephemeral: true });
        const now = new Date(); oldS.endTime = now; await oldS.save();
        await new WorkSession({ userId: tId, guildId: gId, startedBy: newSupId, startTime: now }).save();
        i.update({ content: `✅ **Transferido.**`, components: [] }); updateLiveAdminDash(gId); updatePublicDash(gId);
    }
    if(i.isButton() && i.customId.startsWith('live_ctl_')){
        if(i.customId==='live_ctl_transfer'){
            if(!(await isAdmin(i.member, gId))) return i.reply({content:'⛔', ephemeral:true});
            const active = await WorkSession.find({ guildId: gId, endTime: null }); if(!active.length) return i.reply({content:'Nadie.', ephemeral:true});
            const opts = []; for(const s of active.slice(0,25)) {const m = await i.guild.members.fetch(s.userId).catch(()=>null); opts.push({ label: m?m.displayName:s.userId, value: s.userId });}
            i.reply({ content: 'Sesión a transferir:', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('menu_trans_session').addOptions(opts))], ephemeral: true }); return;
        }
        if(!(await isAdmin(i.member, gId)))return i.reply('⛔'); const act=i.customId.split('_')[2], ss=await WorkSession.find({guildId:gId,endTime:null}); if(!ss.length)return i.reply({content:'Nadie.',ephemeral:true});
        const opts=[]; for(const s of ss.slice(0,25)){const m=await i.guild.members.fetch(s.userId).catch(()=>null); opts.push({label:(m?m.displayName:s.userId).substring(0,25),value:s.userId, emoji:s.isPaused?'🥶':'🟢'});}
        i.reply({content:`${act}:`,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`live_exec_${act}`).addOptions(opts))],ephemeral:true});
    }
    if (i.isStringSelectMenu() && i.customId === 'menu_trans_session') {
        const tId = i.values[0]; i.update({ content: `Transfiriendo <@${tId}>. Nuevo responsable:`, components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`menu_trans_newsup_${tId}`).setMaxValues(1))] });
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('live_exec_')) {
        const act=i.customId.split('_')[2], t=i.values[0], s=await WorkSession.findOne({userId:t,guildId:gId,endTime:null}); if(!s)return i.update('Error.');
        if(act==='pause'){s.isPaused=!s.isPaused; if(!s.isPaused){s.totalPausedMs+=new Date()-s.pauseStartTime;s.pauseStartTime=null;}else{s.pauseStartTime=new Date();} await s.save();}
        if(act==='accumulate'){s.endTime=new Date(); await s.save();} if(act==='cancel'){await WorkSession.deleteOne({_id:s._id});}
        i.update({content:'✅ Hecho.',components:[]}); updateLiveAdminDash(gId); if(s.userId===s.startedBy) updatePublicDash(gId);
    }
    if(i.customId==='btn_start'||i.customId==='btn_stop'){
        const c=await GuildConfig.findOne({guildId:gId}); if(!c)return i.reply({content:'Error',ephemeral:true}); if(c.mode===1)return i.reply({content:'⛔ Solo supervisores.',ephemeral:true});
        if(i.customId==='btn_start'){
            if(c.isFrozen)return i.reply({content:'❄️',ephemeral:true}); const us=await UserState.findOne({userId:uId,guildId:gId}); if(us&&(us.isBanned||us.penaltyUntil>new Date()))return i.reply({content:'⛔',ephemeral:true});
            if(await WorkSession.findOne({userId:uId,guildId:gId,endTime:null}))return i.reply({content:'❌',ephemeral:true});
            await new WorkSession({userId:uId,guildId:gId,startedBy:uId,startTime:new Date()}).save(); i.reply({content:'✅',ephemeral:true});
        }
        if(i.customId==='btn_stop'){ const s=await WorkSession.findOne({userId:uId,guildId:gId,endTime:null}); if(!s)return i.reply({content:'❓',ephemeral:true}); await i.deferReply({ephemeral:true}); s.endTime=new Date(); await s.save(); i.editReply(`👋 ${moment.duration(calculateDuration(s)).format("h:mm")}`);}
        updatePublicDash(gId); updateLiveAdminDash(gId);
    }
    if (i.isButton() && (i.customId.startsWith('btn_time_add_')||i.customId.startsWith('btn_time_sub_'))){
        if(!(await isAdmin(i.member,gId)))return i.reply('⛔'); const act=i.customId.split('_')[2], t=i.customId.split('_')[3];
        i.showModal(new ModalBuilder().setCustomId(`modal_adj_${act}_${t}`).setTitle('Ajustar').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('m').setLabel('Minutos').setStyle(1))));
    }
    if (i.isModalSubmit() && i.customId.startsWith('modal_adj_')){
        const act=i.customId.split('_')[2], t=i.customId.split('_')[3], m=parseInt(i.fields.getTextInputValue('m')); if(!m)return i.reply('Num invalido.');
        const s=await WorkSession.findOne({userId:t,guildId:gId,endTime:{$ne:null}}).sort({startTime:-1}); if(!s)return i.reply('Sin historial.');
        const ms=m*60000; if(act==='add')s.manualAdjustmentMs+=ms; else s.manualAdjustmentMs-=ms; await s.save(); i.reply({content:`✅ Ajustado.`,ephemeral:true});
    }
    if(i.isButton() && i.customId.startsWith('btn_admin_clear_db_')){if(!(await isAdmin(i.member,gId)))return; const t=i.customId.split('_')[4]; i.reply({content:'Confirmar?',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_del_${t}`).setLabel('SI').setStyle(4))],ephemeral:true});}
    if(i.isButton() && i.customId.startsWith('confirm_del_')){const t=i.customId.split('_')[2]; const r=await WorkSession.deleteMany({userId:t,guildId:gId,endTime:{$ne:null}}); i.update({content:`✅ Borrados.`,components:[]});}
    if(i.customId==='btn_reset_config_confirm'){ if(i.user.id!==i.guild.ownerId)return; await GuildConfig.deleteOne({guildId:gId}); i.reply('✅ Reset.'); }
    if(i.isStringSelectMenu() && i.customId.startsWith('menu_penalty_')){ const t=i.customId.split('_')[2], min=parseInt(i.values[0]), u=moment().add(min,'m').toDate(); await UserState.findOneAndUpdate({userId:t,guildId:gId},{penaltyUntil:u,isBanned:false},{upsert:true}); i.update({content:`✅ Multa.`, components:[]}); }
});

async function updatePublicDash(gId) {
    const c=await GuildConfig.findOne({guildId:gId}); if(!c||!c.dashChannelId)return; const ch=await client.channels.fetch(c.dashChannelId).catch(()=>null); if(!ch)return;
    const a=await WorkSession.find({guildId:gId,endTime:null}); 
    
    let l = "";
    if (a.length === 0) {
        l = '*Nadie activo*';
    } else {
        for (const s of a) {
            const userMem = await ch.guild.members.fetch(s.userId).catch(()=>null);
            const userName = userMem ? userMem.displayName : s.userId;
            
            let supInfo = "";
            if (s.startedBy !== s.userId) {
                const supMem = await ch.guild.members.fetch(s.startedBy).catch(()=>null);
                const supName = supMem ? supMem.displayName : s.startedBy;
                supInfo = ` | 👮 ${supName}`;
            }
            l += `• ${s.isPaused?'⏸️':'🟢'} **${userName}**${supInfo}\n`;
        }
    }

    const emb=new EmbedBuilder().setTitle('⏱️ Panel de Asistencia').setDescription(`**Estado:** ${c.isFrozen?'❄️ Cerrado':'🟢 Abierto'}`).setColor(c.isFrozen?0x99AAB5:0x5865F2).addFields({name:'Usuarios Activos',value:l});
    const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_start').setLabel('ENTRAR').setStyle(3),new ButtonBuilder().setCustomId('btn_stop').setLabel('SALIR').setStyle(4));
    const ms=await ch.messages.fetch({limit:5}); const b=ms.find(m=>m.author.id===client.user.id&&m.components.length>0); if(b)b.edit({embeds:[emb],components:[row]}); else ch.send({embeds:[emb],components:[row]});
}

async function updateLiveAdminDash(gId) {
    const c=await GuildConfig.findOne({guildId:gId}); if(!c||!c.liveDashboardMsgId||!c.logChannelId)return; const ch=await client.channels.fetch(c.logChannelId).catch(()=>null); if(!ch)return;
    const a=await WorkSession.find({guildId:gId,endTime:null});
    let d="**Panel Control en Vivo**\n\n"; 
    if(!a.length) d+="\n💤 Sin actividad."; 
    else {
        for(const s of a) {
            const userMem = await ch.guild.members.fetch(s.userId).catch(()=>null);
            const userName = userMem ? userMem.displayName : s.userId;
            let infoSup = "Auto";
            if (s.startedBy !== s.userId) {
                const supMem = await ch.guild.members.fetch(s.startedBy).catch(()=>null);
                infoSup = `👮 ${supMem ? supMem.displayName : s.startedBy}`;
            }
            d+=`> 👤 **${userName}** | ${infoSup}\n` +
               `> 🕒 **Estado:** ${s.isPaused?'⏸️ PAUSA':'🟢 ACTIVO'} (<t:${Math.floor(s.startTime/1000)}:R>)\n\n`;
        }
    }
    const emb=new EmbedBuilder().setTitle('🎛️ Dashboard Admin').setDescription(d).setColor(0x2B2D31).setTimestamp();
    const dis=a.length===0; 
    const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('live_ctl_pause').setLabel('Pausar').setStyle(2).setEmoji('⏸️').setDisabled(dis),
        new ButtonBuilder().setCustomId('live_ctl_accumulate').setLabel('Acumular').setStyle(3).setEmoji('📥').setDisabled(dis),
        new ButtonBuilder().setCustomId('live_ctl_cancel').setLabel('Cancelar').setStyle(4).setEmoji('❌').setDisabled(dis),
        new ButtonBuilder().setCustomId('live_ctl_transfer').setLabel('Transferir').setStyle(1).setEmoji('🔄').setDisabled(dis)
    );
    try{const m=await ch.messages.fetch(c.liveDashboardMsgId); await m.edit({content:'',embeds:[emb],components:[row]});}catch(e){const n=await ch.send({embeds:[emb],components:[row]});c.liveDashboardMsgId=n.id;await c.save();}
}

function sendPublicDashboardMsg(ch,gId){ch.send({embeds:[new EmbedBuilder().setTitle('Cargando...')]}).then(()=>updatePublicDash(gId));}
function refreshAllLiveDashboards(){client.guilds.cache.forEach(g=>updateLiveAdminDash(g.id));}
async function checkAutoSchedules(){
    const cs=await GuildConfig.find({autoCut:{$ne:null},isFrozen:false});
    for(const c of cs){
        const tz=momentTimezone.tz(c.timezone), map={'domingo':'Sunday','lunes':'Monday','martes':'Tuesday','miercoles':'Wednesday','jueves':'Thursday','viernes':'Friday','sabado':'Saturday'};
        const d=c.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
        if(tz.format('dddd')===map[d]&&tz.format('HH:mm')===c.autoCut.time){
            c.isFrozen=true;await c.save();const a=await WorkSession.find({guildId:c.guildId,endTime:null});const l=await client.channels.fetch(c.logChannelId).catch(()=>null);
            for(const s of a){s.endTime=new Date();await s.save();if(l)l.send({embeds:[new EmbedBuilder().setDescription(`⚠️ Auto-Cierre: <@${s.userId}>`).setColor(0xFFA500)]});}
            updatePublicDash(c.guildId);updateLiveAdminDash(c.guildId);
        }
    }
}

process.on('SIGTERM', () => { mongoose.connection.close(false, () => process.exit(0)); });
client.login(process.env.DISCORD_TOKEN);
