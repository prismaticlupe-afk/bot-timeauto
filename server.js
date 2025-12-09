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
    console.error("❌ ERROR CRÍTICO: Falta la variable MONGO_URI en el archivo .env o en la configuración de Render.");
    process.exit(1);
}

mongoose.connect(dbURI)
    .then(() => console.log('🗄️ Base de Datos V17.5 (Multi-Admin) Conectada.'))
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
app.get('/', (req, res) => res.send('Bot V17.5 Multi-Admin Active.'));
app.get('/ping', (req, res) => res.status(200).send('Pong!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    presence: { status: 'online', activities: [{ name: 'Ayuda: !guia', type: ActivityType.Watching }] }
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
            const doc = new PDFDocument();
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            try {
                const imgRes = await axios.get(getHabboHeadUrl(username), { responseType: 'arraybuffer', timeout: 1500 });
                doc.image(imgRes.data, 250, 40, { width: 40 });
            } catch (e) {}

            doc.moveDown(4);
            doc.fontSize(18).text(`Reporte de Asistencia: ${username}`, { align: 'center' });
            doc.fontSize(10).text(`ID: ${userId} | Fecha: ${moment().format('YYYY-MM-DD')}`, { align: 'center' });
            doc.moveDown();

            const startX = 30; 
            let currentY = 150;
            
            // Encabezados Tabla
            doc.font('Helvetica-Bold').fontSize(9);
            doc.text('Fecha', startX, currentY);
            doc.text('Inicio', startX + 60, currentY);
            doc.text('Fin', startX + 110, currentY);
            doc.text('Duración', startX + 160, currentY);
            doc.text('Encargado', startX + 230, currentY); 
            doc.text('Avatar Sup.', startX + 380, currentY); 
            
            doc.moveTo(startX, currentY + 12).lineTo(550, currentY + 12).stroke();
            currentY += 25; 
            doc.font('Helvetica');

            let totalMs = 0;

            for(const s of sessions) {
                if (currentY > 700) { doc.addPage(); currentY = 50; }
                
                const dur = calculateDuration(s); 
                totalMs += dur;
                const tz = timezone || 'UTC';
                
                let initiatorName = "Auto";
                let initiatorAvatarUrl = null;

                if (s.startedBy !== s.userId) {
                    if(guild) {
                        const sup = await guild.members.fetch(s.startedBy).catch(()=>null);
                        initiatorName = sup ? sup.displayName : s.startedBy;
                    } else {
                        initiatorName = s.startedBy;
                    }
                    initiatorAvatarUrl = getHabboHeadUrl(initiatorName);
                } else {
                    initiatorAvatarUrl = getHabboHeadUrl(username);
                }

                const dateStr = moment(s.startTime).tz(tz).format('DD/MM/YY');
                const startStr = moment(s.startTime).tz(tz).format('HH:mm');
                const endStr = s.endTime ? moment(s.endTime).tz(tz).format('HH:mm') : 'Activo';
                const durStr = moment.duration(dur).format("h[h] m[m]");

                doc.text(dateStr, startX, currentY);
                doc.text(startStr, startX + 60, currentY);
                doc.text(endStr, startX + 110, currentY);
                doc.text(durStr, startX + 160, currentY);
                doc.text(initiatorName.substring(0, 25), startX + 230, currentY);

                if (initiatorAvatarUrl) {
                    try {
                        const headRes = await axios.get(initiatorAvatarUrl, { responseType: 'arraybuffer', timeout: 1000 });
                        doc.image(headRes.data, startX + 380, currentY - 5, { width: 20 });
                    } catch (e) {
                        doc.text('-', startX + 380, currentY);
                    }
                }

                currentY += 20;
            }

            doc.moveDown();
            doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL: ${moment.duration(totalMs).format("h[h] m[m]")}`, startX, currentY + 20);
            
            doc.end();
        } catch (e) { 
            reject(e); 
        }
    });
}
client.on('ready', () => {
    console.log(`🤖 V17.5 Online: ${client.user.tag}`);
    setInterval(checkAutoSchedules, 60000);
    setInterval(refreshAllLiveDashboards, 30000);
    
    client.guilds.cache.forEach(g => {
        updatePublicDash(g.id);
        updateLiveAdminDash(g.id); 
    });
});
client.on('messageCreate', async (m) => {
    if (m.author.bot) return;

    // !MITIEMPO
    if (m.content === '!mitiempo') {
        const c = await GuildConfig.findOne({ guildId: m.guild.id });
        if (!c) return m.reply('⚠️ No configurado.');
        m.delete().catch(()=>{}); 
        await m.channel.sendTyping();
        
        const ss = await WorkSession.find({ userId: m.author.id, guildId: m.guild.id, endTime: { $ne: null } });
        let t = ss.reduce((a, s) => a + calculateDuration(s), 0);
        const act = await WorkSession.findOne({ userId: m.author.id, guildId: m.guild.id, endTime: null });
        if(act) t += calculateDuration(act); 
        t = Math.max(0, t);
        
        try { 
            await m.author.send({ embeds: [new EmbedBuilder().setTitle('⏱️ Tu Tiempo').setDescription(`Total Acumulado:\n# ${moment.duration(t).format("h[h] m[m]")}`).setColor(0x5865F2)] }); 
            m.channel.send(`✅ ${m.author}, revisa tus Mensajes Directos.`).then(x=>setTimeout(()=>x.delete(),5000)); 
        } catch(e){ 
            m.channel.send(`❌ ${m.author}, no pude enviarte mensaje. Abre tus MDs.`); 
        }
    }

    // !GUIA
    if (m.content === '!guide' || m.content === '!guia') {
        m.reply({ embeds: [new EmbedBuilder().setTitle('📘 Guía V17.5').setColor(0xFEE75C).addFields({ name: 'Comandos', value: '`!tomar @user`: Iniciar time (Solo canal Control).\n`!nomina`: Ver pagos y PDF.\n`!run`: Configurar Bot.' })] });
    }

    // COMANDOS ADMIN
    if (m.content.startsWith('!')) {
        const adminCmds = ['!run', '!corte', '!time', '!multar', '!bantime', '!activetime', '!nomina', '!tomar'];
        const cmd = m.content.split(' ')[0]; 
        if (!adminCmds.includes(cmd)) return;
        
        // !TOMAR
        if (cmd === '!tomar') {
            const config = await GuildConfig.findOne({ guildId: m.guild.id });
            if (!config) return m.reply('⚠️ No configurado.');
            if (config.mode !== 2 && config.supervisorChannelId && m.channel.id !== config.supervisorChannelId) {
                return m.reply(`⚠️ Comando exclusivo de <#${config.supervisorChannelId}>.`);
            }

            const target = m.mentions.users.first();
            if (!target) return m.reply('⚠️ Uso correcto: `!tomar @usuario`');

            let canTake = false;
            if (m.member.roles.cache.some(r => config.adminRoles.includes(r.id)) || m.author.id === m.guild.ownerId) {
                canTake = true;
            } else if (config.rolePermissions?.length > 0) {
                const takerRoles = m.member.roles.cache.map(r => r.id);
                const targetMember = await m.guild.members.fetch(target.id).catch(()=>null);
                if(!targetMember) return m.reply('Usuario no encontrado en el servidor.');
                const targetRoles = targetMember.roles.cache.map(r => r.id);

                for (const rule of config.rolePermissions) {
                    if (takerRoles.includes(rule.takerRoleId)) {
                        const hasTargetRole = targetRoles.some(r => rule.targetRoleIds.includes(r));
                        if (hasTargetRole) canTake = true;
                    }
                }
            }

            if (!canTake) return m.reply('⛔ No tienes rango suficiente para tomarle tiempo a este usuario.');

            const activeS = await WorkSession.findOne({ userId: target.id, guildId: m.guild.id, endTime: null });
            if (activeS) {
                const starterMember = await m.guild.members.fetch(activeS.startedBy).catch(()=>null);
                return m.reply(`⚠️ El usuario ya tiene time activo.\n**Encargado:** ${starterMember ? starterMember.displayName : 'Desconocido'}`);
            }

            await new WorkSession({ userId: target.id, guildId: m.guild.id, startedBy: m.author.id, startTime: new Date() }).save();
            m.reply(`✅ **Tiempo iniciado** para ${target} por ${m.author}.`);
            updateLiveAdminDash(m.guild.id);
            return;
        }

        if(cmd==='!run' && m.author.id!==m.guild.ownerId) return m.reply('❌ Solo el Dueño puede configurar.');
        if(cmd!=='!run' && !(await isAdmin(m.member, m.guild.id))) return m.reply('⛔ Permiso de Administrador requerido.');
        
        const target = m.mentions.users.first();

        // !NOMINA
        if (cmd === '!nomina') {
            await m.channel.sendTyping();
            const allSessions = await WorkSession.find({ guildId: m.guild.id, endTime: { $ne: null } });
            const totals = {};
            allSessions.forEach(s => { totals[s.userId] = (totals[s.userId] || 0) + calculateDuration(s); });
            const userIds = Object.keys(totals).filter(id => totals[id] > 0).sort((a,b) => totals[b] - totals[a]);
            
            let desc = "**Nómina (Tiempos Acumulados)**\n";
            let count = 0;
            for (const uid of userIds) {
                const mem = await m.guild.members.fetch(uid).catch(()=>null);
                const name = mem ? mem.displayName : uid;
                desc += `**${++count}. ${name}**: \`${moment.duration(totals[uid]).format("h[h] m[m]")}\`\n`;
            }
            if(count===0) desc="✅ Todo pagado/limpio.";
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_nomina_pay').setLabel('Pagado (Reset)').setStyle(ButtonStyle.Success).setEmoji('💸').setDisabled(count===0),
                new ButtonBuilder().setCustomId('btn_nomina_hist').setLabel('Historial PDF').setStyle(ButtonStyle.Primary).setEmoji('📄').setDisabled(count===0)
            );
            m.reply({ embeds: [new EmbedBuilder().setTitle('💰 Gestión de Nómina').setDescription(desc.substring(0,4000)).setColor(0x2B2D31)], components: [row] });
        }

        if (cmd==='!run') {
            const c = await GuildConfig.findOne({ guildId: m.guild.id });
            if(c) return m.reply({ embeds:[new EmbedBuilder().setTitle('⚠️ Ya Configurado').setDescription('El bot ya tiene datos.\nPara re-instalar (cambiar canales/roles), debes resetear primero.').setColor(0xFFA500)], components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_reset_config_confirm').setLabel('🔄 Resetear Configuración').setStyle(ButtonStyle.Danger))] });
            
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_mode_select').setPlaceholder('Selecciona el Modo').addOptions(
                { label: 'Usuarios toman time a usuarios', description: 'Requiere rangos.', value: '1', emoji: '👮' },
                { label: 'Usuarios se toman times solos', description: 'Botones públicos.', value: '2', emoji: '🤖' },
                { label: 'Híbrido (Ambos)', value: '3', emoji: '✨' }
            ));
            m.reply({ content: `👋 **Instalación V17.5**\nElige el modo de operación:`, components: [row] });
        }

        if (cmd==='!corte') { const c=await GuildConfig.findOne({guildId:m.guild.id}); const l=await client.channels.fetch(c.logChannelId).catch(()=>null); if(l){await l.send('✂️ CORTE'); m.reply('✅');} }
        if (cmd.startsWith('!multar') && target) { m.reply({content:`Multando a ${target.tag}`, components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`menu_penalty_${target.id}`).setPlaceholder('Tiempo').addOptions({label:'10m',value:'10'},{label:'30m',value:'30'},{label:'1h',value:'60'}))], ephemeral:true}); }
        if ((cmd.startsWith('!ban')||cmd.startsWith('!active')) && target) { const b=cmd.startsWith('!ban'); await UserState.findOneAndUpdate({userId:target.id, guildId:m.guild.id}, {isBanned:b, penaltyUntil:null}, {upsert:true}); m.reply(`✅ ${target.tag} **${b?'BANEADO':'ACTIVADO'}**.`); }
        if (cmd.startsWith('!time') && target) {
            await m.channel.sendTyping();
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
    if (i.isButton() && isRateLimited(i.user.id)) return i.reply({ content: '⏳ Espera...', ephemeral: true });
    const gId = i.guild.id; const uId = i.user.id;

    if (i.isStringSelectMenu() && i.customId === 'setup_mode_select') {
        if (i.user.id !== i.guild.ownerId) return i.reply({ content: '❌ Owner.', ephemeral: true });
        const mode = parseInt(i.values[0]); setupCache.set(gId, { mode: mode, permissions: [] });
        if (mode === 1 || mode === 3) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_perm_add').setLabel('Agregar Regla').setStyle(ButtonStyle.Success).setEmoji('➕'),
                new ButtonBuilder().setCustomId('setup_perm_finish').setLabel('Terminar Permisos').setStyle(ButtonStyle.Primary)
            );
            await i.update({ content: `✅ Modo ${mode} seleccionado.\n**Definir Jerarquía:** ¿Quién puede tomar time a quién?`, components: [row] });
        } else triggerGeneralSetup(i);
    }

    if (i.customId === 'setup_perm_add') {
        const r1 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_perm_taker').setPlaceholder('Rol Supervisor').setMaxValues(1));
        const r2 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_perm_target').setPlaceholder('Roles Objetivo').setMinValues(1));
        const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_perm_save').setLabel('Guardar Regla').setStyle(ButtonStyle.Success));
        await i.reply({ content: 'Nueva Regla de Permisos:', components: [r1, r2, r3], ephemeral: true });
    }
    if(i.isRoleSelectMenu() && i.customId==='setup_perm_taker') { const c=setupCache.get(uId)||{}; c.tempTaker=i.values[0]; setupCache.set(uId,c); i.deferUpdate(); }
    if(i.isRoleSelectMenu() && i.customId==='setup_perm_target') { const c=setupCache.get(uId)||{}; c.tempTargets=i.values; setupCache.set(uId,c); i.deferUpdate(); }
    if(i.customId === 'setup_perm_save') {
        const cUser = setupCache.get(uId); if(!cUser?.tempTaker || !cUser?.tempTargets) return i.reply({content:'❌ Selecciona ambos roles.', ephemeral:true});
        const cGuild = setupCache.get(gId); cGuild.permissions.push({ takerRoleId: cUser.tempTaker, targetRoleIds: cUser.tempTargets });
        setupCache.set(gId, cGuild); setupCache.delete(uId);
        await i.update({ content: '✅ Regla Guardada.', components: [] });
        await i.message.channel.send({ content: `Reglas guardadas: ${cGuild.permissions.length}`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_perm_add').setLabel('+ Regla').setStyle(3), new ButtonBuilder().setCustomId('setup_perm_finish').setLabel('Continuar').setStyle(1))] });
    }
    if(i.customId === 'setup_perm_finish') triggerGeneralSetup(i);

    async function triggerGeneralSetup(interaction) {
        const msg = "🔧 **Configuración General**\nSelecciona la zona horaria y los roles administradores.";
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
        if (c.mode === 2 || c.mode === 3) m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID Canal FICHAR (Público)").setStyle(1)));
        if (c.mode === 1 || c.mode === 3) m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sup').setLabel("ID Canal Control Tiempos").setStyle(1)));
        await i.showModal(m);
    }
    if(i.isModalSubmit() && i.customId === 'setup_modal_final') {
        const c = setupCache.get(gId); if(!c?.timezone) return i.reply({content:'❌ Falta Zona Horaria.', ephemeral:true});
        const logId = i.fields.getTextInputValue('log');
        const autoRaw = i.fields.getTextInputValue('auto');
        let autoCut = null; if (autoRaw && autoRaw.includes(':') && !autoRaw.toLowerCase().includes('no')) { const p = autoRaw.split(' '); autoCut = { day: p[0], time: p[1] }; }
        let dashId = null, supId = null;
        try { if(c.mode!==1) dashId = i.fields.getTextInputValue('dash'); } catch(e){}
        try { if(c.mode!==2) supId = i.fields.getTextInputValue('sup'); } catch(e){}
        try {
            await GuildConfig.findOneAndUpdate({ guildId: gId }, { mode: c.mode, dashChannelId: dashId, supervisorChannelId: supId, logChannelId: logId, configChannelId: i.channelId, timezone: c.timezone, adminRoles: c.adminRoles, rolePermissions: c.permissions || [], autoCut, isFrozen: false }, { upsert: true, new: true });
            if(dashId) { const ch = await i.guild.channels.fetch(dashId); sendPublicDashboardMsg(ch, gId); }
            const logCh = await i.guild.channels.fetch(logId);
            const m = await logCh.send('Inicio Dashboard Admin...');
            await GuildConfig.findOneAndUpdate({guildId: gId}, {liveDashboardMsgId: m.id});
            updateLiveAdminDash(gId);
            await i.reply({ content: '✅ **Instalación Completada.**', ephemeral: true });
        } catch(e) { i.reply(`Error: ${e.message}`); }
    }

    if (i.isStringSelectMenu() && i.customId.startsWith('menu_nomina_')) {
        const mode = i.customId.split('_')[2], t = i.values[0];
        
        if (mode === 'pay') {
            await i.deferUpdate();
            await WorkSession.deleteMany({ userId: t, guildId: gId, endTime: { $ne: null } });
            i.followUp({ content: `✅ Usuario <@${t}> pagado y reseteado.`, ephemeral: false });
        }
        
        if (mode === 'hist') {
            await i.deferReply({ ephemeral: true });
            
            const ss = await WorkSession.find({ userId: t, guildId: gId, endTime: { $ne: null } }).sort({ startTime: 1 });
            if (!ss.length) return i.editReply('⚠️ No hay historial para este usuario.');
            
            const m = await i.guild.members.fetch(t).catch(() => null);
            const c = await GuildConfig.findOne({ guildId: gId });
            
            try {
                const pdf = await generateHistoryPDF(t, gId, m ? m.displayName : t, ss, c.timezone, i.guild);
                await i.editReply({ 
                    content: `📄 **Reporte Generado para ${m ? m.displayName : t}**`, 
                    files: [new AttachmentBuilder(pdf, { name: `Reporte_${t}.pdf` })] 
                });
            } catch (error) {
                console.error("PDF Error:", error);
                await i.editReply('❌ Error generando el PDF. Intenta de nuevo.');
            }
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
        i.update({ content: `✅ **Transferido.** <@${oldS.startedBy}> ➡️ <@${newSupId}>.`, components: [] });
        updateLiveAdminDash(gId);
    }

    if(i.isButton() && i.customId.startsWith('live_ctl_')){
        if(i.customId==='live_ctl_transfer'){
            if(!(await isAdmin(i.member, gId))) return i.reply({content:'⛔', ephemeral:true});
            const active = await WorkSession.find({ guildId: gId, endTime: null }); if(!active.length) return i.reply({content:'Nadie.', ephemeral:true});
            const opts = []; for(const s of active.slice(0,25)) {const m = await i.guild.members.fetch(s.userId).catch(()=>null); opts.push({ label: m?m.displayName:s.userId, value: s.userId, description: `Sup: ${s.startedBy}` });}
            i.reply({ content: 'Sesión a transferir:', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('menu_trans_session').addOptions(opts))], ephemeral: true });
            return;
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
        if(act==='accumulate'){s.endTime=new Date(); await s.save();}
        if(act==='cancel'){await WorkSession.deleteOne({_id:s._id});}
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
    if(i.isButton() && i.customId.startsWith('confirm_del_')){const t=i.customId.split('_')[2]; const r=await WorkSession.deleteMany({userId:t,guildId:gId,endTime:{$ne:null}}); i.update({content:`✅ Borrados ${r.deletedCount}.`,components:[]});}
    if(i.customId==='btn_reset_config_confirm'){ if(i.user.id!==i.guild.ownerId)return; await GuildConfig.deleteOne({guildId:gId}); i.reply('✅ Reset.'); }
    if(i.isStringSelectMenu() && i.customId.startsWith('menu_penalty_')){ const t=i.customId.split('_')[2], min=parseInt(i.values[0]), u=moment().add(min,'m').toDate(); await UserState.findOneAndUpdate({userId:t,guildId:gId},{penaltyUntil:u,isBanned:false},{upsert:true}); i.update({content:`✅ Multa.`, components:[]}); }
    if(i.customId === 'btn_sup_take_time') i.reply({ content: 'Selecciona:', components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('menu_sup_select_target').setMaxValues(1))], ephemeral: true });
    if(i.isUserSelectMenu() && i.customId === 'menu_sup_select_target') {
        const targetId = i.values[0]; const c = await GuildConfig.findOne({ guildId: gId }); let can = false;
        if (i.member.roles.cache.some(r => c.adminRoles.includes(r.id)) || i.user.id === i.guild.ownerId) can = true;
        else if (c.rolePermissions?.length) { const tr = i.member.roles.cache.map(r => r.id); const tm = await i.guild.members.fetch(targetId).catch(()=>null); if(tm){const ttr = tm.roles.cache.map(r => r.id); for (const r of c.rolePermissions) if (tr.includes(r.takerRoleId) && ttr.some(x => r.targetRoleIds.includes(x))) can = true;}}
        if (!can) return i.reply({content:'⛔ Sin rango.', ephemeral:true});
        if (await WorkSession.findOne({ userId: targetId, guildId: gId, endTime: null })) return i.reply({content:'❌ Ya activo.', ephemeral:true});
        await new WorkSession({ userId: targetId, guildId: gId, startedBy: i.user.id, startTime: new Date() }).save();
        i.reply({content:`✅ Iniciado para <@${targetId}>.`, ephemeral:true}); updateLiveAdminDash(gId);
    }
});

async function updatePublicDash(gId) {
    const c=await GuildConfig.findOne({guildId:gId}); if(!c||!c.dashChannelId)return; const ch=await client.channels.fetch(c.dashChannelId).catch(()=>null); if(!ch)return;
    const a=await WorkSession.find({guildId:gId,endTime:null}); const l=a.map(s=>`• ${s.isPaused?'⏸️':'🟢'} <@${s.userId}>`);
    const emb=new EmbedBuilder().setTitle('⏱️ Fichar (Auto)').setDescription(`Estado: ${c.isFrozen?'❄️':'🟢'}`).setColor(c.isFrozen?0x99AAB5:0x5865F2).addFields({name:'Activos',value:l.length?l.join('\n'):'*Nadie*'});
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
            let userDisplayName = s.userId;
            let starterDisplayName = s.startedBy;
            
            const userMem = await ch.guild.members.fetch(s.userId).catch(()=>null);
            if(userMem) userDisplayName = userMem.displayName;

            let infoSup = "Auto-Servicio";
            if (s.startedBy !== s.userId) {
                const supMem = await ch.guild.members.fetch(s.startedBy).catch(()=>null);
                starterDisplayName = supMem ? supMem.displayName : s.startedBy;
                infoSup = `👮 **Encargado:** ${starterDisplayName}`;
            }

            d+=`> 👤 **Empleado:** ${userDisplayName} | ${infoSup}\n` +
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
