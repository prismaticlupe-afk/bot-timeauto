const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, 
    PermissionsBitField 
} = require('discord.js');
const express = require('express');
const moment = require('moment');
const fs = require('fs');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Lector de Logs Activo.'));
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DB_FILE = './data.json';
let db = { 
    config: {},   // { guildId: { dashId, logId, timezone, adminRoles, autoCut: {day, hour} } }
    sessions: {}, // { userId: { start, guildId, startMsgId } }
    frozen: {}    // { guildId: boolean }
};

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { console.error("Error DB", e); }
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const TIMEZONES = [
    { label: '🇲🇽 México (Centro)', value: 'America/Mexico_City' },
    { label: '🇨🇴/🇵🇪 Colombia/Perú', value: 'America/Bogota' },
    { label: '🇦🇷/🇨🇱 Argentina/Chile', value: 'America/Argentina/Buenos_Aires' },
    { label: '🇻🇪 Venezuela', value: 'America/Caracas' },
    { label: '🇪🇸 España', value: 'Europe/Madrid' },
    { label: '🇺🇸 USA (New York)', value: 'America/New_York' },
    { label: '🇺🇸 USA (Los Angeles)', value: 'America/Los_Angeles' }
];

client.on('ready', () => {
    console.log(`🤖 Bot conectado como ${client.user.tag}`);
    setInterval(checkAutoSchedules, 60000); 
});

async function calculateTotalFromLogs(guildId, userId, logChannelId) {
    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!channel) return 0;

    let totalMs = 0;
    let keepScanning = true;
    let lastId = undefined;
    
 
    let loops = 0;

    while (keepScanning && loops < 5) {
        const messages = await channel.messages.fetch({ limit: 100, before: lastId });
        if (messages.size === 0) break;

        for (const msg of messages.values()) {
            if (msg.content.includes("✂️ CORTE DE CAJA")) {
                keepScanning = false;
                break; 
            }

            if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                const embed = msg.embeds[0];
                
                const userMention = `<@${userId}>`;
                const isUserInEmbed = (embed.description && embed.description.includes(userMention)) || 
                                      (embed.fields && embed.fields.some(f => f.value.includes(userMention)));

                if (isUserInEmbed) {
                
                    const timeField = embed.fields.find(f => f.name.includes("Tiempo") || f.name.includes("Duración") || f.name.includes("Sesión"));
                    
                    if (timeField) {
                        const timeText = timeField.value.replace(/\*/g, '').trim(); 
                        totalMs += parseDurationToMs(timeText);
                    }
                }
            }
            lastId = msg.id;
        }
        loops++;
    }
    return totalMs;
}

function parseDurationToMs(str) {
    let ms = 0;
    const regex = /(\d+)\s*(h|m|s)/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
        const val = parseInt(match[1]);
        const unit = match[2];
        if (unit === 'h') ms += val * 3600000;
        if (unit === 'm') ms += val * 60000;
        if (unit === 's') ms += val * 1000;
    }
    return ms;
}


client.on('messageCreate', async (message) => {
    if (message.content === '!run') {
        if (message.author.id !== message.guild.ownerId) return message.reply('❌ Solo el Owner puede configurar.');

        const rowZone = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('setup_zone').setPlaceholder('🌎 Zona Horaria').addOptions(TIMEZONES)
        );
        const rowRoles = new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('setup_roles').setPlaceholder('👮 Roles Admin (Corte/Freezer)').setMinValues(1).setMaxValues(5)
        );
        const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_continue_setup').setLabel('Siguiente').setStyle(ButtonStyle.Primary)
        );

        await message.reply({ content: '⚙️ **Configuración:** Elige Zona y Roles Admin.', components: [rowZone, rowRoles, rowBtn] });
    }

    if (message.content.startsWith('!')) handleAdminCommands(message);
});

async function handleAdminCommands(message) {
    const guildId = message.guild.id;
    const config = db.config[guildId];
    if (!config) return;

    const isAdmin = message.member.roles.cache.some(r => config.adminRoles.includes(r.id)) || message.author.id === message.guild.ownerId;
    if (!isAdmin && message.content.startsWith('!')) return; // Silencioso si no es admin

    if (message.content === '!freezer') {
        db.frozen[guildId] = true;
        saveDB();
        message.reply('❄️ **Sistema CONGELADO.**');
        updateDashboardMSG(guildId);
    }
    if (message.content === '!unfreezer') {
        db.frozen[guildId] = false;
        saveDB();
        message.reply('🔥 **Sistema ACTIVADO.**');
        updateDashboardMSG(guildId);
    }
    if (message.content === '!corte') {
      
        const logChannel = await client.channels.fetch(config.logId).catch(()=>null);
        if (logChannel) {
            await logChannel.send('✂️ CORTE DE CAJA | -----------------------------------');
            await logChannel.send(`> *El conteo de horas se ha reiniciado desde este punto por: ${message.author}*`);
            message.reply('✅ **Corte Realizado.** El historial de horas acumuladas se reiniciará desde ahora.');
        } else {
            message.reply('❌ Error: No encuentro el canal de logs.');
        }
    }
}

const tempSetup = new Map();

client.on('interactionCreate', async (interaction) => {
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_zone') {
        const cur = tempSetup.get(interaction.guild.id) || {};
        cur.timezone = interaction.values[0];
        tempSetup.set(interaction.guild.id, cur);
        await interaction.deferUpdate();
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup_roles') {
        const cur = tempSetup.get(interaction.guild.id) || {};
        cur.adminRoles = interaction.values;
        tempSetup.set(interaction.guild.id, cur);
        await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId === 'btn_continue_setup') {
        const cur = tempSetup.get(interaction.guild.id);
        if (!cur || !cur.timezone || !cur.adminRoles) return interaction.reply({content:'⚠️ Selecciona Zona y Roles primero.', ephemeral:true});

        const modal = new ModalBuilder().setCustomId('setup_modal_final').setTitle('Configuración Final');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID Canal Panel").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID Canal Logs").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Auto-Cierre (Ej: Domingo 20:00)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal_final') {
        const dashId = interaction.fields.getTextInputValue('dash');
        const logId = interaction.fields.getTextInputValue('log');
        const autoRaw = interaction.fields.getTextInputValue('auto');
        const pre = tempSetup.get(interaction.guild.id);

        let autoCut = null;
        if (autoRaw && autoRaw.includes(' ')) {
            const p = autoRaw.split(' ');
            autoCut = { day: p[0], time: p[1] };
        }

        db.config[interaction.guild.id] = { dashId, logId, timezone: pre.timezone, adminRoles: pre.adminRoles, autoCut };
        saveDB();
        
        const ch = await interaction.guild.channels.fetch(dashId).catch(()=>null);
        if (ch) sendDashboard(ch, interaction.guild.id);
        await interaction.reply({ content: '✅ Configurado.', ephemeral: true });
    }

    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const conf = db.config[guildId];

        if (!conf) return interaction.reply({ content: '⚠️ Bot no configurado.', ephemeral: true });

        if (interaction.customId === 'btn_start') {
            if (db.frozen[guildId]) return interaction.reply({ content: '❄️ Congelado.', ephemeral: true });
            if (db.sessions[userId]) return interaction.reply({ content: '❌ Ya tienes turno.', ephemeral: true });

            const now = Date.now();
            
            const logChannel = await client.channels.fetch(conf.logId).catch(()=>null);
            let startMsgId = null;
            if (logChannel) {
                const startEmbed = new EmbedBuilder().setDescription(`🟢 <@${userId}> ha iniciado turno.`).setColor(0x57F287);
                const m = await logChannel.send({ embeds: [startEmbed] });
                startMsgId = m.id;
            }

            db.sessions[userId] = { start: now, guildId, startMsgId };
            saveDB();
            updateDashboardMSG(guildId);
            return interaction.reply({ content: '✅ Turno iniciado.', ephemeral: true });
        }

        if (interaction.customId === 'btn_stop') {
            if (!db.sessions[userId]) return interaction.reply({ content: '❓ No tienes turno.', ephemeral: true });

            await interaction.deferReply({ ephemeral: true }); 
            const session = db.sessions[userId];
            const now = Date.now();
            const currentSessionMs = now - session.start;

            const logChannel = await client.channels.fetch(conf.logId).catch(()=>null);
            if (logChannel && session.startMsgId) {
                try { await logChannel.messages.delete(session.startMsgId); } catch (e) {}
            }

            const historyMs = await calculateTotalFromLogs(guildId, userId, conf.logId);
            const totalMs = historyMs + currentSessionMs; // Histórico + Lo que acaba de hacer

            const sessionStr = moment.duration(currentSessionMs).format("h[h] m[m] s[s]");
            const totalStr = moment.duration(totalMs).format("h[h] m[m]");

            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('📕 Registro de Turno')
                    .setThumbnail(interaction.user.displayAvatarURL())
                    .setColor(0xED4245)
                    .addFields(
                        { name: '👤 Usuario', value: `<@${userId}>`, inline: true },
                        { name: '⏱️ Sesión', value: `**${sessionStr}**`, inline: true },
                        { name: '📚 Total Acumulado', value: `**${totalStr}**`, inline: true }, // ESTE ES EL DATO CLAVE
                        { name: '📅 Inicio', value: `<t:${Math.floor(session.start/1000)}:t>`, inline: true },
                        { name: '📅 Fin', value: `<t:${Math.floor(now/1000)}:t>`, inline: true }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
            }

            delete db.sessions[userId];
            saveDB();
            updateDashboardMSG(guildId);
            return interaction.editReply(`👋 Turno cerrado.\nSesión: **${sessionStr}**\nTotal: **${totalStr}**`);
        }
    }
});

async function checkAutoSchedules() {
    for (const guildId in db.config) {
        const conf = db.config[guildId];
        if (!conf.autoCut || db.frozen[guildId]) continue; 

        const nowTz = momentTimezone.tz(conf.timezone);
        const daysMap = {'domingo':'Sunday', 'lunes':'Monday', 'martes':'Tuesday', 'miercoles':'Wednesday', 'jueves':'Thursday', 'viernes':'Friday', 'sabado':'Saturday'};
        const dayInput = conf.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Quitar acentos
        const targetDayEng = daysMap[dayInput];
        
        if (nowTz.format('dddd') === targetDayEng && nowTz.format('HH:mm') === conf.autoCut.time) {
            db.frozen[guildId] = true;
            await closeAllSessions(guildId);
            const ch = await client.channels.fetch(conf.logId).catch(()=>null);
            if (ch) ch.send('🤖 **AUTO-CORTE:** Sistema congelado y turnos cerrados por horario.');
            updateDashboardMSG(guildId);
            saveDB();
        }
    }
}

async function closeAllSessions(guildId) {
    const conf = db.config[guildId];
    const logChannel = await client.channels.fetch(conf.logId).catch(()=>null);
    const now = Date.now();

    for (const userId in db.sessions) {
        if (db.sessions[userId].guildId === guildId) {
            const session = db.sessions[userId];
            const duration = now - session.start;
            const durStr = moment.duration(duration).format("h[h] m[m]");

            // Borrar msg inicio
            if (logChannel && session.startMsgId) try { await logChannel.messages.delete(session.startMsgId); } catch(e){}

            // Calcular acumulado rápido (opcional en cierre masivo para no saturar API)
            // En cierre masivo, a veces es mejor solo mostrar la sesión para no tardar 10 mins calculando a 50 personas
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setDescription(`⚠️ **Cierre Automático** <@${userId}>\nSesión guardada: **${durStr}**`)
                    .setColor(0xFFA500);
                logChannel.send({ embeds: [embed] });
            }
            delete db.sessions[userId];
        }
    }
    saveDB();
}

async function sendDashboard(channel, guildId) {
    const embed = new EmbedBuilder()
        .setTitle('⏱️ Panel de Tiempos')
        .setDescription('Sistema de Fichaje')
        .setColor(0x5865F2)
        .addFields({ name: 'Estado', value: db.frozen[guildId] ? '❄️ CONGELADO' : '🟢 ACTIVO' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_start').setLabel('Entrar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_stop').setLabel('Salir').setStyle(ButtonStyle.Danger)
    );
    channel.send({ embeds: [embed], components: [row] });
}

async function updateDashboardMSG(guildId) {
    const conf = db.config[guildId];
    if(!conf) return;
    const ch = await client.channels.fetch(conf.dashId).catch(()=>null);
    if(!ch) return;

    let list = [];
    for (const uid in db.sessions) {
        if (db.sessions[uid].guildId === guildId) list.push(`• <@${uid}> (<t:${Math.floor(db.sessions[uid].start/1000)}:R>)`);
    }
    const embed = new EmbedBuilder()
        .setTitle('⏱️ Panel de Tiempos')
        .setDescription(`**Estado:** ${db.frozen[guildId] ? '❄️ CONGELADO' : '🟢 ACTIVO'}`)
        .setColor(db.frozen[guildId] ? 0x99AAB5 : 0x5865F2)
        .addFields({ name: 'Usuarios Activos', value: list.length ? list.join('\n') : '*Nadie*' });

    const msgs = await ch.messages.fetch({ limit: 10 });
    const botMsg = msgs.find(m => m.author.id === client.user.id && m.components.length > 0);
    if (botMsg) botMsg.edit({ embeds: [embed] });
}

process.on('SIGTERM', async () => {
  
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
