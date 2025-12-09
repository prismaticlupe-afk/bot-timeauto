
try { require('dotenv').config(); } catch (e) {}

const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, 
    PermissionsBitField, ActivityType 
} = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');
const mongoose = require('mongoose');

const dbURI = process.env.MONGO_URI;

if (!dbURI) {
    console.error("❌ ERROR CRÍTICO: No se encontró la variable de entorno MONGO_URI.");
    console.error("Por favor, configúrala en el panel de Render (Environment). El bot se apagará.");
    process.exit(1);
}

mongoose.connect(dbURI)
    .then(() => console.log('🗄️ Conexión exitosa a MongoDB Atlas (Nube).'))
    .catch(err => {
        console.error('❌ Error de conexión a MongoDB:', err);
        process.exit(1);
    });


const GuildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    dashChannelId: { type: String, required: true },
    logChannelId: { type: String, required: true },
    timezone: { type: String, required: true },
    adminRoles: [String],
    autoCut: { day: String, time: String },
    isFrozen: { type: Boolean, default: false }
});
const GuildConfig = mongoose.model('GuildConfig', GuildConfigSchema);

const WorkSessionSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, default: null }, // null = sesión activa
    startMessageId: String
});
const WorkSession = mongoose.model('WorkSession', WorkSessionSchema);


const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot V12 MongoDB Activo y Seguro.'));
app.get('/ping', (req, res) => { res.status(200).send('Pong! 🏓'); });
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    presence: { status: 'online', activities: [{ name: 'Ayuda: !guia', type: 3 }] }
});

const rateLimits = new Map(); 
const SPAM_COOLDOWN = 3000;

const TIMEZONES = [
    { label: '🇲🇽 México (Centro)', value: 'America/Mexico_City' },
    { label: '🇨🇴/🇵🇪 Colombia/Perú', value: 'America/Bogota' },
    { label: '🇦🇷/🇨🇱 Argentina/Chile', value: 'America/Argentina/Buenos_Aires' },
    { label: '🇻🇪 Venezuela', value: 'America/Caracas' },
    { label: '🇪🇸 España', value: 'Europe/Madrid' },
    { label: '🇺🇸 USA (New York)', value: 'America/New_York' }
];

// ==========================================
// 🚀 INICIO
// ==========================================
client.on('ready', async () => {
    console.log(`🤖 Bot V12 (DB) Conectado: ${client.user.tag}`);
    console.log("✅ Sistema listo. Usando MongoDB como memoria principal.");
    
    setInterval(checkAutoSchedules, 60000);
    
    client.guilds.cache.forEach(async (guild) => {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        if (config) {
            updateDash(guild.id);
        }
    });
});

// ==========================================
// 🛡️ SEGURIDAD Y AUXILIARES
// ==========================================
function isRateLimited(userId) {
    const now = Date.now();
    const last = rateLimits.get(userId);
    if (last && (now - last < SPAM_COOLDOWN)) return true;
    rateLimits.set(userId, now);
    return false;
}


// ==========================================
// 💬 COMANDOS
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!guide' || message.content === '!guia') {
        const guideEmbed = new EmbedBuilder()
            .setTitle('📘 Configuración Inicial del Bot (Versión DB)')
            .setDescription('Sigue estos pasos para configurar el sistema de asistencia profesional.')
            .setColor(0xFEE75C)
            .addFields(
                { name: 'Paso 1: Crear Canales Necesarios', value: 'Necesitas 3 canales de texto:\n\n🔒 `#config-bot` (Privado para Admins).\n📣 `#fichar` (Público para empleados).\n📜 `#logs` (Privado para Admins).' },
                { name: 'Paso 2: Obtener IDs', value: 'Activa el "Modo Desarrollador" en Discord y copia las IDs de `#fichar` y `#logs`.' },
                { name: 'Paso 3: Ejecutar Instalación', value: 'Ve al canal privado `#config-bot` y escribe `!run`.' }
            )
            .setFooter({ text: 'Solo el dueño del servidor puede ejecutar !run' });
        return message.reply({ embeds: [guideEmbed] });
    }

    if (message.content === '!help') {
        return message.reply({ embeds: [new EmbedBuilder().setTitle('Ayuda').setColor(0x5865F2).addFields({ name: 'Comandos', value: '`!guia`, `!run`, `!time @Usuario`, `!corte`' })] });
    }

    if (message.content === '!run') {
        if (message.author.id !== message.guild.ownerId) return message.reply('❌ Solo el Dueño del servidor (Owner) puede usar esto.');

        const existingConfig = await GuildConfig.findOne({ guildId: message.guild.id });
        
        if (existingConfig) {
             return message.reply(`⚠️ **El bot ya está configurado.**\nSi necesitas reconfigurarlo, contacta al desarrollador para resetear la base de datos de este servidor.`);
        }

        if (message.channel.permissionsFor(message.guild.roles.everyone).has(PermissionsBitField.Flags.ViewChannel)) {
             message.reply('⚠️ **Recomendación:** Usa este comando en un canal privado (ej. `#config-bot`).');
        }
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sys_setup_trigger').setLabel('⚙️ Iniciar Instalación').setStyle(ButtonStyle.Success));
        await message.channel.send({ content: `👋 **Menú de Instalación (V12 DB)**\nTen a mano las IDs de tus canales.`, components: [row] });
    }

    if (message.content === '!corte') {
        const config = await GuildConfig.findOne({ guildId: message.guild.id });
        if (!config) return message.reply('⚠️ Bot no configurado.');
        
        const isAdm = message.member.roles.cache.some(r => config.adminRoles.includes(r.id)) || message.author.id === message.guild.ownerId;
        if (!isAdm) return message.reply('⛔ Sin permiso.');

        const logCh = await client.channels.fetch(config.logId).catch(()=>null);
        if (logCh) {
            await logCh.send('✂️ CORTE DE CAJA (Marca visual) | -----------------------------------');
            await logCh.send(`> *Corte realizado por: ${message.author}*. (Nota: Con la base de datos, el historial antiguo sigue guardado, pero esta marca ayuda visualmente).`);
        }
    }

    if (message.content.startsWith('!time')) {
        const config = await GuildConfig.findOne({ guildId: message.guild.id });
        if (!config) return message.reply('⚠️ Bot no configurado.');
        
        const isAdm = message.member.roles.cache.some(r => config.adminRoles.includes(r.id)) || message.author.id === message.guild.ownerId;
        if (!isAdm) return message.reply('⛔ Sin permiso.');

        const target = message.mentions.users.first();
        if (!target) return message.reply('⚠️ Menciona al usuario: `!time @Juan`');

        await message.channel.sendTyping();

        const sessions = await WorkSession.find({ 
            userId: target.id, 
            guildId: message.guild.id,
            endTime: { $ne: null } 
        });

        let totalMs = 0;
        for (const session of sessions) {
            totalMs += (new Date(session.endTime) - new Date(session.startTime));
        }

        const tStr = moment.duration(totalMs).format("h[h] m[m]");
        const emb = new EmbedBuilder().setTitle(`⏱️ Reporte DB: ${target.username}`).addFields({ name: 'Tiempo Acumulado Histórico', value: `**${tStr}**\n*(Registros: ${sessions.length})*` }).setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_accumulate_${target.id}`).setLabel('Borrar Historial DB').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
        await message.reply({ embeds: [emb], components: [row] });
    }
});

// ==========================================
// 🖱️ INTERACCIONES
// ==========================================
const tempSetup = new Map();

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && isRateLimited(interaction.user.id)) return interaction.reply({ content: '⏳ Espera...', ephemeral: true });

    // SETUP
    if (interaction.isButton() && interaction.customId === 'sys_setup_trigger') {
        if (interaction.user.id !== interaction.guild.ownerId) return interaction.reply({content:'❌ Solo Owner.', ephemeral:true});
        const r1 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_zone').setPlaceholder('1. Selecciona Zona Horaria').addOptions(TIMEZONES));
        const r2 = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_roles').setPlaceholder('2. Roles ADMIN (Jefes)').setMinValues(1).setMaxValues(5));
        const r3 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_continue_setup').setLabel('Siguiente (Poner IDs)').setStyle(ButtonStyle.Primary));
        await interaction.reply({ content: '🔧 **Configuración Paso 1/2**', components: [r1, r2, r3], ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_zone') {
        const c = tempSetup.get(interaction.guild.id)||{}; c.timezone=interaction.values[0]; tempSetup.set(interaction.guild.id, c); await interaction.deferUpdate();
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup_roles') {
        const c = tempSetup.get(interaction.guild.id)||{}; c.adminRoles=interaction.values; tempSetup.set(interaction.guild.id, c); await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId === 'btn_continue_setup') {
        const m = new ModalBuilder().setCustomId('setup_modal_final').setTitle('Configuración de Canales');
        m.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID del Canal Público (fichar)").setPlaceholder("Ej: 129384...").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID del Canal Privado (logs)").setPlaceholder("Ej: 938475...").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Auto-Cierre (Opcional)").setPlaceholder("Ej: lunes 23:59").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal_final') {
        const dashId = interaction.fields.getTextInputValue('dash');
        const logId = interaction.fields.getTextInputValue('log');
        const autoRaw = interaction.fields.getTextInputValue('auto');
        const pre = tempSetup.get(interaction.guild.id);
        if(!pre || !pre.timezone) return interaction.reply({content:'⚠️ Faltó seleccionar la Zona Horaria.', ephemeral:true});
        let autoCut = null; if (autoRaw && autoRaw.includes(' ')) { const p = autoRaw.split(' '); autoCut = { day: p[0], time: p[1] }; }

        try {
            const dashCh = await interaction.guild.channels.fetch(dashId).catch(()=>null);
            const logCh = await interaction.guild.channels.fetch(logId).catch(()=>null);
            if(!dashCh || !logCh) throw new Error("No se pudieron encontrar los canales o faltan permisos.");

            await GuildConfig.findOneAndUpdate(
                { guildId: interaction.guild.id }, // Filtro de búsqueda
                { // Datos a guardar/actualizar
                    dashChannelId: dashId,
                    logChannelId: logId,
                    timezone: pre.timezone,
                    adminRoles: pre.adminRoles,
                    autoCut: autoCut,
                    isFrozen: false
                },
                { upsert: true, new: true }
            );

            sendDashboard(dashCh, interaction.guild.id);
            
            await interaction.reply({ content: `✅ **Instalación Correcta (Base de Datos)**.\nConfiguración guardada de forma segura en la nube. El panel se ha enviado a <#${dashId}>.`, ephemeral: true });

        } catch (error) {
            console.error(error);
            await interaction.reply({ content: `⚠️ Error guardando en la base de datos: ${error.message}`, ephemeral: true });
        }
    }

    if (interaction.isButton() && interaction.customId.startsWith('btn_accumulate_')) {
        const targetId = interaction.customId.split('_')[2];
        const config = await GuildConfig.findOne({ guildId: interaction.guild.id });
        if(!config) return interaction.reply({content:'⚠️ Error de config.', ephemeral:true});
        
        const isAdm = interaction.member.roles.cache.some(r=>config.adminRoles.includes(r.id)) || interaction.user.id===interaction.guild.ownerId;
        if(!isAdm) return interaction.reply({content:'⛔ Solo Admins.', ephemeral:true});
        
        await interaction.reply({content:'⏳ Borrando historial de la base de datos...', ephemeral:true});
        
        const result = await WorkSession.deleteMany({ 
            userId: targetId, 
            guildId: interaction.guild.id,
            endTime: { $ne: null } 
        });

        await interaction.editReply(`✅ Historial borrado de la base de datos. (${result.deletedCount} registros eliminados).`);
    }

    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        const uId = interaction.user.id;
        const gId = interaction.guild.id;
        
        const config = await GuildConfig.findOne({ guildId: gId });
        if(!config) return interaction.reply({content:'⚠️ El bot no está configurado en este servidor.', ephemeral:true});

        const activeSession = await WorkSession.findOne({ userId: uId, guildId: gId, endTime: null });

        if(interaction.customId==='btn_start'){
            if(config.isFrozen) return interaction.reply({content:'❄️ Sistema cerrado automáticamente.', ephemeral:true});
            if(activeSession) return interaction.reply({content:'❌ Ya tienes una sesión abierta.', ephemeral:true});
            
            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            let mId = null;
            if(logCh){ const m = await logCh.send({embeds:[new EmbedBuilder().setDescription(`🟢 <@${uId}> ha iniciado turno.`).setColor(0x57F287)]}); mId = m.id; }
            
            const newSession = new WorkSession({
                userId: uId,
                guildId: gId,
                startTime: new Date(),
                startMessageId: mId
            });
            await newSession.save();
            // -----------------------------

            updateDash(gId);
            return interaction.reply({content:'✅ Turno iniciado y registrado en base de datos.', ephemeral:true});
        }

        if(interaction.customId==='btn_stop'){
            if(!activeSession) return interaction.reply({content:'❓ No has iniciado turno.', ephemeral:true});
            await interaction.deferReply({ephemeral:true});
            
            activeSession.endTime = new Date();
            await activeSession.save();

            const dur = activeSession.endTime - activeSession.startTime;

            const allSessions = await WorkSession.find({ userId: uId, guildId: gId, endTime: { $ne: null } });
            const grandTotalMs = allSessions.reduce((acc, s) => acc + (new Date(s.endTime) - new Date(s.startTime)), 0);

            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            if(logCh && activeSession.startMessageId) try{ await logCh.messages.delete(activeSession.startMessageId); }catch(e){}
            
            if(logCh){
                const emb = new EmbedBuilder().setTitle('📕 Turno Cerrado (DB)').addFields({name:'Usuario', value:`<@${uId}>`, inline:true},{name:'Esta Sesión', value:`**${moment.duration(dur).format("h[h] m[m]")}**`, inline:true},{name:'Total Histórico', value:`**${moment.duration(grandTotalMs).format("h[h] m[m]")}**`, inline:true}).setColor(0xED4245).setTimestamp();
                await logCh.send({embeds:[emb]});
            }
            
            updateDash(gId);
            return interaction.editReply(`👋 Cerrado.\nSesión guardada: **${moment.duration(dur).format("h[h] m[m]")}**`);
        }
    }
});

async function sendDashboard(channel, guildId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_start').setLabel('ENTRAR').setStyle(ButtonStyle.Success).setEmoji('🟢'),
        new ButtonBuilder().setCustomId('btn_stop').setLabel('SALIR').setStyle(ButtonStyle.Danger).setEmoji('🔴')
    );
    const emb = new EmbedBuilder().setTitle('⏱️ Control de Asistencia (DB)').setDescription('**Estado:** 🟢 Sistema Activo').setColor(0x5865F2).addFields({ name: 'Activos Ahora', value: 'Cargando...' });
    await channel.send({ embeds: [emb], components: [row] });
    updateDash(guildId);
}

async function updateDash(gId){
    const config = await GuildConfig.findOne({ guildId: gId });
    if(!config) return;
    const ch = await client.channels.fetch(config.dashChannelId).catch(()=>null); if(!ch)return;

    const activeSessions = await WorkSession.find({ guildId: gId, endTime: null });
    let l = activeSessions.map(s => `• <@${s.userId}> (<t:${Math.floor(new Date(s.startTime).getTime()/1000)}:R>)`);

    const emb = new EmbedBuilder().setTitle('⏱️ Control de Asistencia (DB)').setDescription(`**Estado:** ${config.isFrozen?'❄️ Cerrado':'🟢 Activo'}`).setColor(config.isFrozen?0x99AAB5:0x5865F2).addFields({name:'Activos Ahora', value:l.length?l.join('\n'):'*Nadie*'});
    const ms = await ch.messages.fetch({limit:10});
    const b = ms.find(m=>m.author.id===client.user.id && m.components.length>0);
    if(b) b.edit({embeds:[emb]});
}

async function checkAutoSchedules() {
    const configs = await GuildConfig.find({ autoCut: { $ne: null }, isFrozen: false });

    for(const config of configs){
        const tz = momentTimezone.tz(config.timezone);
        const map = {'domingo':'Sunday','lunes':'Monday','martes':'Tuesday','miercoles':'Wednesday','jueves':'Thursday','viernes':'Friday','sabado':'Saturday'};
        const day = config.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        if(tz.format('dddd')===map[day] && tz.format('HH:mm')===config.autoCut.time){
            config.isFrozen = true;
            await config.save();

            const activeSessions = await WorkSession.find({ guildId: config.guildId, endTime: null });
            const logCh = await client.channels.fetch(config.logChannelId).catch(()=>null);
            
            for(const session of activeSessions){
                session.endTime = new Date();
                await session.save();
                 if(logCh) logCh.send({embeds:[new EmbedBuilder().setDescription(`⚠️ Auto-Cierre DB: Sesión de <@${session.userId}> finalizada.`).setColor(0xFFA500)]});
            }
            updateDash(config.guildId);
        }
    }
}

process.on('SIGTERM', () => {
    // Cierre limpio de la conexión al apagar el servidor
    mongoose.connection.close();
    process.exit(0);
});
client.login(process.env.DISCORD_TOKEN);
