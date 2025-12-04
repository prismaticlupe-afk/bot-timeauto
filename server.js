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
app.get('/', (req, res) => res.send('Bot V4 Persistente Activo.'));
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DB_FILE = './data.json';
let db = { config: {}, sessions: {}, frozen: {} };

if (fs.existsSync(DB_FILE)) { try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) {} }
function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e){} }

const TIMEZONES = [
    { label: '🇲🇽 México (Centro)', value: 'America/Mexico_City' },
    { label: '🇨🇴/🇵🇪 Colombia/Perú', value: 'America/Bogota' },
    { label: '🇦🇷/🇨🇱 Argentina/Chile', value: 'America/Argentina/Buenos_Aires' },
    { label: '🇻🇪 Venezuela', value: 'America/Caracas' },
    { label: '🇪🇸 España', value: 'Europe/Madrid' },
    { label: '🇺🇸 USA (New York)', value: 'America/New_York' }
];

client.on('ready', async () => {
    console.log(`🤖 Bot V4 conectado: ${client.user.tag}`);
    
    const envGuild = process.env.GUILD_ID;
    const envDash = process.env.DASH_ID;
    const envLog = process.env.LOG_ID;
    const envRole = process.env.ADMIN_ROLE;
    const envZone = process.env.TIMEZONE || 'America/Mexico_City';

    if (envGuild && envDash && envLog) {
        console.log("📂 Cargando configuración permanente desde Render...");
        
        db.config[envGuild] = {
            dashId: envDash,
            logId: envLog,
            timezone: envZone,
            adminRoles: envRole ? [envRole] : [],
            autoCut: null 
        };
        saveDB();
        
        const channel = await client.channels.fetch(envDash).catch(()=>null);
        if (channel) updateDashboardMSG(envGuild);
        
        console.log("✅ ¡Configuración restaurada con éxito!");
    } else {
        console.log("⚠️ No se encontraron variables de entorno completas. Se requiere !run manual.");
    }

    setInterval(checkAutoSchedules, 60000);
});

// ==========================================
// LÓGICA DE CÁLCULO (Logs)
// ==========================================
async function calculateTotalFromLogs(guildId, userId, logChannelId) {
    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!channel) return 0;

    let totalMs = 0;
    let keepScanning = true;
    let lastId = undefined;
    let loops = 0;

    while (keepScanning && loops < 8) {
        const messages = await channel.messages.fetch({ limit: 100, before: lastId });
        if (messages.size === 0) break;

        for (const msg of messages.values()) {
            if (msg.content.includes("✂️ CORTE DE CAJA")) { keepScanning = false; break; }
            
            if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                const embed = msg.embeds[0];
                const userMention = `<@${userId}>`;
                const isUser = (embed.description?.includes(userMention)) || (embed.fields?.some(f => f.value.includes(userMention)));

                if (isUser) {
                    const timeField = embed.fields.find(f => f.name.includes("Sesión") || f.name.includes("Tiempo") || f.name.includes("Duración"));
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

async function clearUserLogs(logChannel, userId) {
    let deletedCount = 0;
    let keepScanning = true;
    let lastId = undefined;
    let loops = 0;

    while (keepScanning && loops < 8) {
        const messages = await logChannel.messages.fetch({ limit: 100, before: lastId });
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
            if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                const embed = msg.embeds[0];
                const userMention = `<@${userId}>`;
                const isUser = (embed.description?.includes(userMention)) || (embed.fields?.some(f => f.value.includes(userMention)));
                if (isUser) {
                    try { await msg.delete(); deletedCount++; await new Promise(r => setTimeout(r, 500)); } catch (e) {}
                }
            }
            lastId = msg.id;
        }
        loops++;
    }
    return deletedCount;
}

function parseDurationToMs(str) {
    let ms = 0;
    const regex = /(\d+)\s*(h|m|s)/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
        const val = parseInt(match[1]);
        if (match[2] === 'h') ms += val * 3600000;
        if (match[2] === 'm') ms += val * 60000;
        if (match[2] === 's') ms += val * 1000;
    }
    return ms;
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!run') {
        if (message.author.id !== message.guild.ownerId) return message.reply('❌ Solo el Owner.');
        message.delete().catch(()=>{});
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sys_setup_trigger').setLabel('⚙️ Iniciar Configuración').setStyle(ButtonStyle.Secondary)
        );
        const msg = await message.channel.send({ content: `👋 Configuración Manual (Solo Owner).`, components: [row] });
        setTimeout(() => msg.delete().catch(()=>{}), 30000);
        return;
    }

    if (message.content.startsWith('!time')) {
        const config = db.config[message.guild.id];
        
        if (!config) return message.reply('⚠️ **Error Crítico:** Bot desconfigurado. Agrega las variables `GUILD_ID`, `DASH_ID`, `LOG_ID` en Render para hacerlo permanente.');

        const adminRoles = config.adminRoles || [];
        const isOwner = message.author.id === message.guild.ownerId;
        const hasRole = message.member.roles.cache.some(r => adminRoles.includes(r.id));

        if (!isOwner && !hasRole) return message.reply('⛔ No tienes permiso.');

        const targetUser = message.mentions.users.first();
        if (!targetUser) return message.reply('⚠️ Menciona a un usuario: `!time @Juan`');

        await message.channel.sendTyping();
        const totalMs = await calculateTotalFromLogs(message.guild.id, targetUser.id, config.logId);
        const totalStr = moment.duration(totalMs).format("h[h] m[m]");

        const embed = new EmbedBuilder()
            .setTitle(`⏱️ Tiempo: ${targetUser.username}`)
            .addFields({ name: 'Total Acumulado', value: `**${totalStr}**` })
            .setColor(0x5865F2);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_accumulate_${targetUser.id}`).setLabel('💰 Acumular / Reset').setStyle(ButtonStyle.Success).setEmoji('📥')
        );

        await message.reply({ embeds: [embed], components: [row] });
    }
});


const tempSetup = new Map();

client.on('interactionCreate', async (interaction) => {
    
    if (interaction.isButton() && interaction.customId === 'sys_setup_trigger') {
        if (interaction.user.id !== interaction.guild.ownerId) return interaction.reply({content:'❌ Solo el Owner.', ephemeral:true});
        const rowZone = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup_zone').setPlaceholder('🌎 Zona Horaria').addOptions(TIMEZONES));
        const rowRoles = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup_roles').setPlaceholder('👮 Roles Admin').setMinValues(1).setMaxValues(5));
        const rowBtn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_continue_setup').setLabel('Siguiente').setStyle(ButtonStyle.Primary));
        await interaction.reply({ content: '🔧 Configuración Manual:', components: [rowZone, rowRoles, rowBtn], ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_zone') {
        const cur = tempSetup.get(interaction.guild.id) || {}; cur.timezone = interaction.values[0]; tempSetup.set(interaction.guild.id, cur); await interaction.deferUpdate();
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup_roles') {
        const cur = tempSetup.get(interaction.guild.id) || {}; cur.adminRoles = interaction.values; tempSetup.set(interaction.guild.id, cur); await interaction.deferUpdate();
    }
    if (interaction.isButton() && interaction.customId === 'btn_continue_setup') {
        const modal = new ModalBuilder().setCustomId('setup_modal_final').setTitle('Canales');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID Panel").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID Logs").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Auto-Cierre").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal_final') {
        const dashId = interaction.fields.getTextInputValue('dash');
        const logId = interaction.fields.getTextInputValue('log');
        const autoRaw = interaction.fields.getTextInputValue('auto');
        const pre = tempSetup.get(interaction.guild.id) || { timezone: 'America/Mexico_City', adminRoles: [] };
        
        let autoCut = null;
        if (autoRaw && autoRaw.includes(' ')) { const p = autoRaw.split(' '); autoCut = { day: p[0], time: p[1] }; }

        db.config[interaction.guild.id] = { dashId, logId, timezone: pre.timezone, adminRoles: pre.adminRoles, autoCut };
        saveDB();
        const ch = await interaction.guild.channels.fetch(dashId).catch(()=>null);
        if (ch) sendDashboard(ch, interaction.guild.id);
        await interaction.reply({ content: '✅ Configurado.', ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('btn_accumulate_')) {
        const targetUserId = interaction.customId.split('_')[2];
        const config = db.config[interaction.guild.id];
        if (!config) return interaction.reply({ content: '⚠️ Bot desconfigurado.', ephemeral: true });

        const isAdmin = interaction.member.roles.cache.some(r => (config.adminRoles||[]).includes(r.id)) || interaction.user.id === interaction.guild.ownerId;
        if (!isAdmin) return interaction.reply({ content: '⛔ Sin permiso.', ephemeral: true });

        await interaction.reply({ content: '⏳ Limpiando historial...', ephemeral: true });
        const logChannel = await client.channels.fetch(config.logId).catch(()=>null);
        if (logChannel) {
            const count = await clearUserLogs(logChannel, targetUserId);
            await interaction.editReply(`✅ **Reset Completo**\nSe borraron **${count}** registros de <@${targetUserId}>.`);
        } else {
            await interaction.editReply('❌ No encontré el canal de logs.');
        }
    }

    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const conf = db.config[guildId];

        if (!conf) return interaction.reply({ content: '⚠️ Bot no configurado (Revisa variables en Render).', ephemeral: true });

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
            return interaction.reply({ content: '✅ Iniciado.', ephemeral: true });
        }

        if (interaction.customId === 'btn_stop') {
            if (!db.sessions[userId]) return interaction.reply({ content: '❓ No tienes turno.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });

            const session = db.sessions[userId];
            const now = Date.now();
            const currentSessionMs = now - session.start;
            const logChannel = await client.channels.fetch(conf.logId).catch(()=>null);
            
            if (logChannel && session.startMsgId) try { await logChannel.messages.delete(session.startMsgId); } catch (e) {}

            const historyMs = await calculateTotalFromLogs(guildId, userId, conf.logId);
            const totalMs = historyMs + currentSessionMs;
            const sessionStr = moment.duration(currentSessionMs).format("h[h] m[m] s[s]");
            const totalStr = moment.duration(totalMs).format("h[h] m[m]");

            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('📕 Turno Cerrado')
                    .setThumbnail(interaction.user.displayAvatarURL())
                    .setColor(0xED4245)
                    .addFields(
                        { name: '👤 Usuario', value: `<@${userId}>`, inline: true },
                        { name: '⏱️ Sesión', value: `**${sessionStr}**`, inline: true },
                        { name: '📚 Acumulado', value: `**${totalStr}**`, inline: true },
                        { name: 'Inicio', value: `<t:${Math.floor(session.start/1000)}:t>`, inline: true },
                        { name: 'Fin', value: `<t:${Math.floor(now/1000)}:t>`, inline: true }
                    ).setTimestamp();
                const rowAcc = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_accumulate_${userId}`).setLabel('Acumular').setStyle(ButtonStyle.Secondary).setEmoji('📥'));
                await logChannel.send({ embeds: [logEmbed], components: [rowAcc] });
            }
            delete db.sessions[userId];
            saveDB();
            updateDashboardMSG(guildId);
            return interaction.editReply(`👋 Cerrado.\nSesión: **${sessionStr}**\nTotal: **${totalStr}**`);
        }
    }
});

async function checkAutoSchedules() {
    for (const guildId in db.config) {
        const conf = db.config[guildId];
        if (!conf.autoCut || db.frozen[guildId]) continue;
        const nowTz = momentTimezone.tz(conf.timezone);
        const daysMap = {'domingo':'Sunday', 'lunes':'Monday', 'martes':'Tuesday', 'miercoles':'Wednesday', 'jueves':'Thursday', 'viernes':'Friday', 'sabado':'Saturday'};
        const dayInput = conf.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (nowTz.format('dddd') === daysMap[dayInput] && nowTz.format('HH:mm') === conf.autoCut.time) {
            db.frozen[guildId] = true; await closeAllSessions(guildId); saveDB(); updateDashboardMSG(guildId);
        }
    }
}
async function closeAllSessions(guildId) {
    const conf = db.config[guildId];
    const logChannel = await client.channels.fetch(conf.logId).catch(()=>null);
    for (const userId in db.sessions) {
        if (db.sessions[userId].guildId === guildId) {
            if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setDescription(`⚠️ **Cierre Auto** <@${userId}>`).setColor(0xFFA500)] });
            delete db.sessions[userId];
        }
    }
}
async function sendDashboard(channel, guildId) {
    const embed = new EmbedBuilder().setTitle('⏱️ Panel de Tiempos').setDescription('Sistema de Fichaje').setColor(0x5865F2).addFields({ name: 'Estado', value: db.frozen[guildId] ? '❄️ CONGELADO' : '🟢 ACTIVO' });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('btn_start').setLabel('Entrar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('btn_stop').setLabel('Salir').setStyle(ButtonStyle.Danger));
    channel.send({ embeds: [embed], components: [row] });
}
async function updateDashboardMSG(guildId) {
    const conf = db.config[guildId];
    if(!conf) return;
    const ch = await client.channels.fetch(conf.dashId).catch(()=>null);
    if(!ch) return;
    let list = [];
    for (const uid in db.sessions) if (db.sessions[uid].guildId === guildId) list.push(`• <@${uid}> (<t:${Math.floor(db.sessions[uid].start/1000)}:R>)`);
    const embed = new EmbedBuilder().setTitle('⏱️ Panel de Tiempos').setDescription(`**Estado:** ${db.frozen[guildId] ? '❄️ CONGELADO' : '🟢 ACTIVO'}`).setColor(db.frozen[guildId] ? 0x99AAB5 : 0x5865F2).addFields({ name: 'Usuarios Activos', value: list.length ? list.join('\n') : '*Nadie*' });
    const msgs = await ch.messages.fetch({ limit: 10 });
    const botMsg = msgs.find(m => m.author.id === client.user.id && m.components.length > 0);
    if (botMsg) botMsg.edit({ embeds: [embed] });
}

process.on('SIGTERM', () => process.exit(0));
client.login(process.env.DISCORD_TOKEN);
