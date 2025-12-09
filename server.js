try { require('dotenv').config(); } catch (e) {}

const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
    TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
    PermissionsBitField, ActivityType, ComponentType
} = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');
const mongoose = require('mongoose');

const dbURI = process.env.MONGO_URI;
if (!dbURI) {
    console.error("❌ ERROR CRÍTICO: Falta MONGO_URI en variables de entorno.");
    process.exit(1);
}

mongoose.connect(dbURI)
    .then(() => console.log('🗄️ MongoDB Atlas Conectado (V13 Enterprise).'))
    .catch(err => { console.error('❌ Error MongoDB:', err); process.exit(1); });


const GuildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    dashChannelId: String, 
    logChannelId: String,  
    configChannelId: String, 
    timezone: String,
    adminRoles: [String],
    autoCut: { day: String, time: String },
    isFrozen: { type: Boolean, default: false },
    liveDashboardMsgId: String 
});
const GuildConfig = mongoose.model('GuildConfig', GuildConfigSchema);

const WorkSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, default: null }, 
    startMessageId: String, 
    isPaused: { type: Boolean, default: false }, 
    pauseStartTime: Date, 
    totalPausedMs: { type: Number, default: 0 } 
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
app.get('/', (req, res) => res.send('Bot V13 Enterprise Activo.'));
app.get('/ping', (req, res) => res.status(200).send('Pong! 🏓'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    presence: { status: 'online', activities: [{ name: 'Ayuda: !guia | V13', type: ActivityType.Watching }] }
});

const rateLimits = new Map();
const SPAM_COOLDOWN = 3000;
const tempSetup = new Map();

const TIMEZONES = [
    { label: '🇲🇽 México (Centro)', value: 'America/Mexico_City' },
    { label: '🇨🇴/🇵🇪 Colombia/Perú', value: 'America/Bogota' },
    { label: '🇦🇷/🇨🇱 Argentina/Chile', value: 'America/Argentina/Buenos_Aires' },
    { label: '🇻🇪 Venezuela', value: 'America/Caracas' },
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

    return totalElapsed - session.totalPausedMs - currentPauseDuration;
}

client.on('ready', async () => {
    console.log(`🤖 V13 Enterprise Online: ${client.user.tag}`);
    
    setInterval(checkAutoSchedules, 60000); 
    setInterval(refreshAllLiveDashboards, 30000); 

    client.guilds.cache.forEach(guild => {
        updatePublicDash(guild.id);
    });
});


client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!mitiempo') {
        const config = await GuildConfig.findOne({ guildId: message.guild.id });
        if (!config) return message.reply('⚠️ Bot no configurado aquí.');
        message.delete().catch(()=>{}); 

        await message.channel.sendTyping();
        
        const closedSessions = await WorkSession.find({ userId: message.author.id, guildId: message.guild.id, endTime: { $ne: null } });
        let totalMs = closedSessions.reduce((acc, s) => acc + calculateDuration(s), 0);

        const activeSession = await WorkSession.findOne({ userId: message.author.id, guildId: message.guild.id, endTime: null });
        if (activeSession) {
            totalMs += calculateDuration(activeSession);
        }

        const tStr = moment.duration(totalMs).format("h[h] m[m] s[s]");
        const emb = new EmbedBuilder().setTitle('⏱️ Tu Tiempo Acumulado').setDescription(`Tu tiempo total registrado en este servidor es:\n# ${tStr}`).setColor(0x5865F2).setFooter({text:'Incluye sesión actual si está activa.'});
        
        try {
            await message.author.send({ embeds: [emb] });
            message.channel.send(`✅ ${message.author}, te envié tu reporte por mensaje directo 📩.`).then(m => setTimeout(() => m.delete(), 5000));
        } catch (error) {
            message.channel.send(`❌ ${message.author}, no pude enviarte MD. Abre tus mensajes directos para ver tu reporte.`).then(m => setTimeout(() => m.delete(), 10000));
        }
        return;
    }

    if (message.content === '!guide' || message.content === '!guia') {
        const guideEmbed = new EmbedBuilder()
            .setTitle('📘 Guía V13 Enterprise')
            .setDescription('Sistema avanzado de control de asistencia y moderación.')
            .setColor(0xFEE75C)
            .addFields(
                { name: '🤖 Para Usuarios', value: '`!mitiempo`: Recibe por MD tu tiempo total acumulado.\nEn el canal de fichar:\n🟢 **Entrar**: Inicia turno.\n🔴 **Salir**: Termina turno.' },
                { name: '🛡️ Para Admins (Comandos)', value: '`!time @user`: Ver historial completo y opción de borrar.\n`!multar @user`: Abre menú para aplicar penalización temporal.\n`!bantime @user`: Bloquea al usuario permanentemente.\n`!activetime @user`: Desbloquear usuario.\n`!corte`: Marca visual en logs.\n`!run`: (Solo Owner) Re-instalar.' },
                { name: '🎛️ Dashboard en Vivo (Nuevo)', value: 'En el canal `#logs` habrá un panel en tiempo real. Usa los botones debajo para Pausar, Forzar Salida o Cancelar sesiones activas.' }
            );
        return message.reply({ embeds: [guideEmbed] });
    }

    if (message.content.startsWith('!')) {
        const adminCommands = ['!run', '!corte', '!time', '!multar', '!bantime', '!activetime'];
        const commandBase = message.content.split(' ')[0];
        if (!adminCommands.includes(commandBase)) return;

        if (message.content.startsWith('!run')) {
             if (message.author.id !== message.guild.ownerId) return message.reply('❌ Solo el Dueño (Owner) puede usar !run.');
        } else {
             if (!(await isAdmin(message.member, message.guild.id))) return message.reply('⛔ Acceso denegado. Rol de Admin requerido.');
        }

        const target = message.mentions.users.first();

        if (message.content.startsWith('!multar')) {
            if (!target) return message.reply('⚠️ Menciona al usuario: `!multar @usuario`');
            const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`menu_penalty_${target.id}`).setPlaceholder('Selecciona la duración de la multa').addOptions(
                { label: '10 Minutos', value: '10', emoji: '⏱️' }, { label: '30 Minutos', value: '30', emoji: '⏲️' }, { label: '1 Hora', value: '60', emoji: '⏰' }
            ));
            message.reply({ content: `👮‍♂️ Configurando multa para ${target.tag}...`, components: [row], ephemeral: true });
        }

        if (message.content.startsWith('!bantime') || message.content.startsWith('!activetime')) {
            if (!target) return message.reply('⚠️ Menciona al usuario.');
            const isBan = message.content.startsWith('!bantime');
            await UserState.findOneAndUpdate(
                { userId: target.id, guildId: message.guild.id },
                { isBanned: isBan, penaltyUntil: null }, 
                { upsert: true }
            );
            message.reply(`✅ Usuario ${target.tag} ha sido **${isBan ? 'BANEADO 🚫' : 'ACTIVADO 🟢'}** del sistema de fichaje.`);
        }

        if (message.content.startsWith('!time')) {
            if (!target) return message.reply('⚠️ Menciona al usuario: `!time @usuario`');
            await message.channel.sendTyping();
            const sessions = await WorkSession.find({ userId: target.id, guildId: message.guild.id, endTime: { $ne: null } });
            let totalMs = sessions.reduce((acc, s) => acc + calculateDuration(s), 0);
            const active = await WorkSession.findOne({ userId: target.id, guildId: message.guild.id, endTime: null });
            if(active) totalMs += calculateDuration(active);

            const tStr = moment.duration(totalMs).format("h[h] m[m] s[s]");
            const emb = new EmbedBuilder().setTitle(`⏱️ Reporte Admin: ${target.username}`).addFields({ name: 'Tiempo Total (Histórico + Activo)', value: `**${tStr}**` }).setColor(0x5865F2);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_admin_clear_db_${target.id}`).setLabel('BORRAR Historial DB').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
            message.reply({ embeds: [emb], components: [row] });
        }

        if (message.content === '!corte') {
            const config = await GuildConfig.findOne({ guildId: message.guild.id });
            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            if (logCh) {
                await logCh.send('✂️ CORTE DE CAJA (Marca Visual) | -----------------------------------');
                message.reply('✅ Marca de corte enviada a logs.');
            }
        }

        if (message.content === '!run') {
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sys_setup_trigger').setLabel('⚙️ Iniciar Instalación V13').setStyle(ButtonStyle.Success));
            message.reply({ content: `👋 **Instalación Enterprise V13**\nAsegúrate de tener creados los canales: \`#fichar\` (público) y \`#logs\` (privado).`, components: [row] });
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && isRateLimited(interaction.user.id)) return interaction.reply({ content: '⏳ Calma, espera unos segundos...', ephemeral: true });

    const gId = interaction.guild.id;
    const uId = interaction.user.id;

    if (interaction.customId === 'sys_setup_trigger') {
        if (interaction.user.id !== interaction.guild.ownerId) return interaction.reply({content:'❌ Solo Owner.', ephemeral:true});
        const r1 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_zone').setPlaceholder('1. Selecciona Zona Horaria').addOptions(TIMEZONES));
        const r2 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_roles').setPlaceholder('2. Roles ADMIN (Jefes)').setMinValues(1).setMaxValues(5));
        const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_continue_setup').setLabel('Siguiente (Poner IDs)').setStyle(ButtonStyle.Primary));
        await interaction.reply({ content: '🔧 **Configuración V13 - Paso 1**', components: [r1, r2, r3], ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_zone') {
        const c = tempSetup.get(gId)||{}; c.timezone=interaction.values[0]; tempSetup.set(gId, c); await interaction.deferUpdate();
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup_roles') {
        const c = tempSetup.get(gId)||{}; c.adminRoles=interaction.values; tempSetup.set(gId, c); await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId === 'btn_continue_setup') {
        const m = new ModalBuilder().setCustomId('setup_modal_final').setTitle('Configuración de Canales V13');
        m.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID Canal FICHAR (Público)").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID Canal LOGS (Privado Admin)").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Auto-Cierre (Ej: lunes 23:59)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal_final') {
        const dashId = interaction.fields.getTextInputValue('dash');
        const logId = interaction.fields.getTextInputValue('log');
        const autoRaw = interaction.fields.getTextInputValue('auto');
        const pre = tempSetup.get(gId);
        if(!pre || !pre.timezone) return interaction.reply({content:'⚠️ Faltó seleccionar Zona Horaria en el paso anterior.', ephemeral:true});
        let autoCut = null; if (autoRaw && autoRaw.includes(' ')) { const p = autoRaw.split(' '); autoCut = { day: p[0], time: p[1] }; }

        try {
            const dashCh = await interaction.guild.channels.fetch(dashId).catch(()=>null);
            const logCh = await interaction.guild.channels.fetch(logId).catch(()=>null);
            if(!dashCh || !logCh) throw new Error("No encuentro los canales o no tengo permisos.");

            const config = await GuildConfig.findOneAndUpdate(
                { guildId: gId },
                { dashChannelId: dashId, logChannelId: logId, configChannelId: interaction.channelId, timezone: pre.timezone, adminRoles: pre.adminRoles, autoCut: autoCut, isFrozen: false },
                { upsert: true, new: true }
            );

            sendPublicDashboardMsg(dashCh, gId);

            if(config.liveDashboardMsgId) { try { (await logCh.messages.fetch(config.liveDashboardMsgId)).delete(); } catch(e){} }
            const liveMsg = await logCh.send({ content: 'Iniciando Dashboard en Vivo...' });
            config.liveDashboardMsgId = liveMsg.id; await config.save();
            updateLiveAdminDash(gId); // Llenarlo con datos

            await interaction.reply({ content: `✅ **Instalación V13 Completa**.\n- Panel Público en <#${dashId}>\n- Dashboard Admin en Vivo en <#${logId}>`, ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: `⚠️ Error: ${error.message}`, ephemeral: true });
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('menu_penalty_')) {
        const targetId = interaction.customId.split('_')[2];
        const minutes = parseInt(interaction.values[0]);
        const until = moment().add(minutes, 'minutes').toDate();

        await UserState.findOneAndUpdate(
            { userId: targetId, guildId: gId },
            { penaltyUntil: until, isBanned: false }, 
            { upsert: true }
        );
        const timestamp = Math.floor(until.getTime() / 1000);
        interaction.update({ content: `✅ **Multa Aplicada** a <@${targetId}>.\nNo podrá fichar hasta: <t:${timestamp}:F> (<t:${timestamp}:R>).`, components: [], ephemeral: false });
    }


    if (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop') {
        const config = await GuildConfig.findOne({ guildId: gId });
        if(!config) return interaction.reply({content:'⚠️ Error de configuración.', ephemeral:true});

        if(interaction.customId==='btn_start'){
            if(config.isFrozen) return interaction.reply({content:'❄️ El sistema está cerrado por horario.', ephemeral:true});

            const userState = await UserState.findOne({ userId: uId, guildId: gId });
            if (userState) {
                if (userState.isBanned) return interaction.reply({ content: '⛔ **Acceso Denegado:** Estás permanentemente bloqueado de este sistema.', ephemeral: true });
                if (userState.penaltyUntil && userState.penaltyUntil > new Date()) {
                    return interaction.reply({ content: `👮‍♂️ **Multa Activa:** No puedes fichar hasta <t:${Math.floor(userState.penaltyUntil/1000}:R>.`, ephemeral: true });
                }
            }

            if (await WorkSession.findOne({ userId: uId, guildId: gId, endTime: null })) {
                return interaction.reply({ content: '❌ Ya tienes una sesión activa. Debes salir primero.', ephemeral: true });
            }

            await new WorkSession({ userId: uId, guildId: gId, startTime: new Date() }).save();
            interaction.reply({content:'✅ **Turno Iniciado.**', ephemeral:true});
        }

        if(interaction.customId==='btn_stop'){
            const session = await WorkSession.findOne({ userId: uId, guildId: gId, endTime: null });
            if(!session) return interaction.reply({content:'❓ No tienes un turno activo para cerrar.', ephemeral:true});

            await interaction.deferReply({ephemeral:true});
            
            session.endTime = new Date();
            await session.save(); // Guardar cierre

            const durationMs = calculateDuration(session); // Calcular duración real (sin pausas)

            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            if(logCh) logCh.send(`📕 **Cierre:** <@${uId}> terminó turno. Duración: \`${moment.duration(durationMs).format("h:mm")}\``);

            interaction.editReply(`👋 **Turno Cerrado.**\nTiempo registrado: **${moment.duration(durationMs).format("h[h] m[m]")}**`);
        }

        updatePublicDash(gId);
        updateLiveAdminDash(gId);
    }


    if (interaction.isButton() && interaction.customId.startsWith('btn_admin_clear_db_')) {
        if(!(await isAdmin(interaction.member, gId))) return interaction.reply({content:'⛔ Solo Admins.', ephemeral:true});
        const targetId = interaction.customId.split('_')[4]; // El ID está en la posición 4
        
        const confirmRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_delete_${targetId}`).setLabel('⚠️ CONFIRMAR BORRADO TOTAL').setStyle(ButtonStyle.Danger));
        interaction.reply({content:`⚠️ **¿Estás seguro?** Esto borrará PERMANENTEMENTE todo el historial cerrado de <@${targetId}> en la base de datos. No se puede deshacer.`, components:[confirmRow], ephemeral:true});
    }
    if (interaction.isButton() && interaction.customId.startsWith('confirm_delete_')) {
        const targetId = interaction.customId.split('_')[2];
        await interaction.update({content:'⏳ Borrando...', components:[]});
        const result = await WorkSession.deleteMany({ userId: targetId, guildId: gId, endTime: { $ne: null } });
        interaction.editReply(`✅ **Base de Datos Limpiada.** Se eliminaron ${result.deletedCount} registros históricos de <@${targetId}>.`);
    }

    
    if (interaction.isButton() && interaction.customId.startsWith('live_ctl_')) {
        if(!(await isAdmin(interaction.member, gId))) return interaction.reply({content:'⛔ Permiso de Admin requerido.', ephemeral:true});
        
        const action = interaction.customId.split('_')[2]; // 'pause', 'force', 'cancel'
        const activeSessions = await WorkSession.find({ guildId: gId, endTime: null });
        
        if (activeSessions.length === 0) return interaction.reply({content:'No hay usuarios activos para gestionar.', ephemeral:true});

        const options = [];
        for(const s of activeSessions.slice(0, 25)){ // Límite de 25 opciones en Discord
            const member = await interaction.guild.members.fetch(s.userId).catch(()=>null);
            const name = member ? (member.nickname || member.user.username) : `Usuario ${s.userId}`;
            const statusEmoji = s.isPaused ? '🥶' : '🟢';
            options.push({
                label: name.substring(0, 25),
                value: s.userId,
                emoji: statusEmoji,
                description: s.isPaused ? 'Actualmente PAUSADO' : 'Actualmente CORRIENDO'
            });
        }

        const menu Rowland = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`live_exec_${action}`) 
                .setPlaceholder(`Selecciona usuario para: ${action.toUpperCase()}`)
                .addOptions(options)
        );

        interaction.reply({ content: `Selecciona a quién aplicar la acción: **${action.toUpperCase()}**`, components: [menuRow], ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('live_exec_')) {
        const action = interaction.customId.split('_')[2];
        const targetId = interaction.values[0];
        
        const session = await WorkSession.findOne({ userId: targetId, guildId: gId, endTime: null });
        if (!session) return interaction.update({ content: '❌ Ese usuario ya no tiene una sesión activa.', components: [] });

        let msg = '';
        
        // --- ACCIÓN: PAUSAR / REANUDAR ---
        if (action === 'pause') {
            if (session.isPaused) {
                // REANUDAR
                session.isPaused = false;
                const pauseDuration = new Date() - session.pauseStartTime;
                session.totalPausedMs += pauseDuration;
                session.pauseStartTime = null;
                msg = `▶️ **Reanudado:** Sesión de <@${targetId}> activa de nuevo.`;
            } else {
                // PAUSAR
                session.isPaused = true;
                session.pauseStartTime = new Date();
                msg = `⏸️ **Pausado:** Sesión de <@${targetId}> congelada. El tiempo no correrá.`;
            }
            await session.save();
        }
        
        else if (action === 'force') {
            session.endTime = new Date();
            await session.save();
            const dur = calculateDuration(session);
             msg = `📥 **Salida Forzada:** <@${targetId}> cerrado por admin. Tiempo guardado: ${moment.duration(dur).format("h:mm")}.`;
        }
        
        else if (action === 'cancel') {
            await WorkSession.deleteOne({ _id: session._id });
            msg = `❌ **Sesión Cancelada:** La sesión actual de <@${targetId}> ha sido borrada y NO se guardará tiempo.`;
        }

        interaction.update({ content: `✅ Acción ejecutada: ${msg}`, components: [] });
        updateLiveAdminDash(gId);
        updatePublicDash(gId);
    }
});



async function updatePublicDash(gId) {
    const config = await GuildConfig.findOne({ guildId: gId }); if (!config || !config.dashChannelId) return;
    const ch = await client.channels.fetch(config.dashChannelId).catch(() => null); if (!ch) return;

    const active = await WorkSession.find({ guildId: gId, endTime: null });
    const l = active.map(s => `• ${s.isPaused ? '⏸️ (Pausado)' : '🟢'} <@${s.userId}> (<t:${Math.floor(s.startTime / 1000)}:R>)`);

    const emb = new EmbedBuilder().setTitle('⏱️ Control de Asistencia').setDescription(`**Estado del Sistema:** ${config.isFrozen ? '❄️ Cerrado' : '🟢 Abierto'}`).setColor(config.isFrozen ? 0x99AAB5 : 0x5865F2).addFields({ name: 'Personal Activo', value: l.length ? l.join('\n') : '*Ninguno*' });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_start').setLabel('ENTRAR').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('btn_stop').setLabel('SALIR').setStyle(ButtonStyle.Danger));
    
    const ms = await ch.messages.fetch({ limit: 5 });
    const b = ms.find(m => m.author.id === client.user.id && m.components.length > 0);
    if (b) b.edit({ embeds: [emb], components: [row] });
}

async function updateLiveAdminDash(gId) {
    const config = await GuildConfig.findOne({ guildId: gId }); if (!config || !config.liveDashboardMsgId || !config.logChannelId) return;
    const ch = await client.channels.fetch(config.logChannelId).catch(() => null); if (!ch) return;

    const active = await WorkSession.find({ guildId: gId, endTime: null });

    let desc = "**Panel de Control en Tiempo Real**\nEste mensaje se actualiza automáticamente. Usa los botones para gestionar sesiones.\n────────────────────────\n";

    if (active.length === 0) {
        desc += "\n💤 **No hay sesiones activas en este momento.**";
    } else {
        for (const s of active) {
            const currentDur = calculateDuration(s);
            const statusIcon = s.isPaused ? "⏸️ PAUSADO" : "🟢 CORRIENDO";
            desc += `\n> **<@${s.userId}>** | ${statusIcon}\n> └ Inicio: <t:${Math.floor(s.startTime / 1000)}:t> | Llevaba: **${moment.duration(currentDur).format("h[h] m[m] s[s]")}**\n`;
        }
    }
    desc += "\n────────────────────────";

    const emb = new EmbedBuilder().setTitle('🎛️ Dashboard Admin en Vivo').setDescription(desc).setColor(0x2B2D31).setTimestamp().setFooter({text:'Última actualización'});

    const isDisabled = active.length === 0;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('live_ctl_pause').setLabel('Pausar/Reanudar...').setStyle(ButtonStyle.Secondary).setEmoji('⏸️').setDisabled(isDisabled),
        new ButtonBuilder().setCustomId('live_ctl_force').setLabel('Forzar Salida...').setStyle(ButtonStyle.Success).setEmoji('📥').setDisabled(isDisabled),
        new ButtonBuilder().setCustomId('live_ctl_cancel').setLabel('Cancelar Sesión...').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(isDisabled)
    );

    try {
        const msg = await ch.messages.fetch(config.liveDashboardMsgId);
        await msg.edit({ content: '', embeds: [emb], components: [row] });
    } catch (e) {
        const newMsg = await ch.send({ embeds: [emb], components: [row] });
        config.liveDashboardMsgId = newMsg.id;
        await config.save();
    }
}

async function sendPublicDashboardMsg(channel, guildId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_start').setLabel('ENTRAR').setStyle(ButtonStyle.Success).setEmoji('🟢'),
        new ButtonBuilder().setCustomId('btn_stop').setLabel('SALIR').setStyle(ButtonStyle.Danger).setEmoji('🔴')
    );
    const emb = new EmbedBuilder().setTitle('⏱️ Control de Asistencia').setDescription('Cargando...').setColor(0x5865F2);
    await channel.send({ embeds: [emb], components: [row] });
    updatePublicDash(guildId); // Llenar con datos
}

function refreshAllLiveDashboards() {
    client.guilds.cache.forEach(g => updateLiveAdminDash(g.id));
}

async function checkAutoSchedules() {
    const configs = await GuildConfig.find({ autoCut: { $ne: null }, isFrozen: false });

    for(const config of configs){
        const tz = momentTimezone.tz(config.timezone);
        const map = {'domingo':'Sunday','lunes':'Monday','martes':'Tuesday','miercoles':'Wednesday','jueves':'Thursday','viernes':'Friday','sabado':'Saturday'};
        const dayInput = config.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        if(tz.format('dddd') === map[dayInput] && tz.format('HH:mm') === config.autoCut.time){
            console.log(`⏰ Ejecutando Auto-Cierre para guild: ${config.guildId}`);
            
            config.isFrozen = true;
            await config.save();

            const activeSessions = await WorkSession.find({ guildId: config.guildId, endTime: null });
            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            
            const now = new Date();
            for(const session of activeSessions){
                session.endTime = now;
                await session.save();
                const dur = calculateDuration(session, now);
                 if(logCh) logCh.send({embeds:[new EmbedBuilder().setDescription(`⚠️ **Auto-Cierre:** Sesión de <@${session.userId}> finalizada automáticamente.\nTiempo guardado: ${moment.duration(dur).format("h:mm")}`).setColor(0xFFA500)]});
            }
            updatePublicDash(config.guildId);
            updateLiveAdminDash(config.guildId);
        }
    }
}
process.on('SIGTERM', () => {
    console.log('SIGTERM recibido. Cerrando conexión DB y saliendo...');
    mongoose.connection.close(false, () => {
        console.log('MongoDB cerrado.');
        process.exit(0);
    });
});

client.login(process.env.DISCORD_TOKEN);
