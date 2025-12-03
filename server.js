const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, PermissionsBitField 
} = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot de Tiempos Premium Activo.'));
app.listen(port, () => console.log(`Web lista en puerto ${port}`));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const activeSessions = new Map();
const cooldowns = new Map();
const guildConfigs = new Map();

client.on('ready', () => {
    console.log(`💎 Bot conectado como ${client.user.tag}`);
});

async function emergencyShutdown() {
    console.log("🚨 REINICIO DETECTADO: Cerrando tiempos...");
    const now = Date.now();

    const sessionsByGuild = {};
    
    for (const [userId, data] of activeSessions.entries()) {
        if (!sessionsByGuild[data.guildId]) sessionsByGuild[data.guildId] = [];
        sessionsByGuild[data.guildId].push({ userId, startTime: data.startTime });
    }

    for (const [guildId, sessions] of Object.entries(sessionsByGuild)) {
        const config = guildConfigs.get(guildId);
        if (!config) continue; // Si no hay config, no podemos loguear

        const logChannel = await client.channels.fetch(config.logId).catch(() => null);
        
        if (logChannel) {
            let description = "**⚠️ Times cerrados por reinicio del servidor.**\nEn breve se activará la toma de times nuevamente.\n\n**Resumen de cierres automáticos:**\n";
            
            sessions.forEach(session => {
                const durationMs = now - session.startTime;
                const duration = moment.duration(durationMs).format("h [h], m [min], s [seg]");
                description += `> 👤 <@${session.userId}> | ⏳ **${duration}**\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle('🛑 REINICIO DEL SISTEMA')
                .setDescription(description)
                .setColor(0xFFA500) // Naranja
                .setFooter({ text: 'Todos los tiempos han sido guardados.' })
                .setTimestamp();

            await logChannel.send({ embeds: [embed] });
        }
    }
    
    process.exit(0);
}

process.on('SIGTERM', emergencyShutdown);
process.on('SIGINT', emergencyShutdown);

client.on('messageCreate', async (message) => {
    if (message.content === '!run') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('❌ Solo administradores.');
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_setup_open')
                .setLabel('🛠️ Configurar Panel')
                .setStyle(ButtonStyle.Primary)
        );

        await message.reply({ 
            content: 'Haz clic abajo para configurar canales, horarios y zona horaria.', 
            components: [row] 
        });
    }
});

client.on('interactionCreate', async (interaction) => {
    
    if (interaction.isButton() && interaction.customId === 'btn_setup_open') {
        const modal = new ModalBuilder().setCustomId('setup_modal').setTitle('Configuración del Sistema');

        const inputDash = new TextInputBuilder()
            .setCustomId('inp_dash').setLabel("ID Canal Botones").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ej: 144563...');
        
        const inputLog = new TextInputBuilder()
            .setCustomId('inp_log').setLabel("ID Canal Logs").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ej: 144563...');

        const inputZone = new TextInputBuilder()
            .setCustomId('inp_zone').setLabel("Zona Horaria (Ej: America/Mexico_City)").setStyle(TextInputStyle.Short).setRequired(true).setValue('America/Mexico_City');

        const inputHorario = new TextInputBuilder()
            .setCustomId('inp_sched').setLabel("Horario (Ej: 08-20) o escribe 'NO'").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ej: 09-18 para 9am a 6pm, o NO');

        modal.addComponents(
            new ActionRowBuilder().addComponents(inputDash),
            new ActionRowBuilder().addComponents(inputLog),
            new ActionRowBuilder().addComponents(inputZone),
            new ActionRowBuilder().addComponents(inputHorario)
        );

        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal') {
        const dashId = interaction.fields.getTextInputValue('inp_dash');
        const logId = interaction.fields.getTextInputValue('inp_log');
        const zone = interaction.fields.getTextInputValue('inp_zone');
        const schedRaw = interaction.fields.getTextInputValue('inp_sched');

        const dashCh = await interaction.guild.channels.fetch(dashId).catch(()=>null);
        const logCh = await interaction.guild.channels.fetch(logId).catch(()=>null);
        if (!dashCh || !logCh) return interaction.reply({content: '❌ IDs de canal inválidos.', ephemeral:true});

        let schedule = null;
        if (schedRaw.toUpperCase() !== 'NO') {
            const parts = schedRaw.split('-');
            if (parts.length === 2) {
                schedule = { start: parseInt(parts[0]), end: parseInt(parts[1]) };
            }
        }

        guildConfigs.set(interaction.guild.id, {
            dashboardId: dashId,
            logId: logId,
            timezone: zone,
            schedule: schedule
        });

        const embed = new EmbedBuilder()
            .setTitle('⏱️ Control de Asistencia')
            .setDescription(`**Estado:** Sistema Operativo\n**Zona Horaria:** ${zone}\n**Horario:** ${schedule ? `${schedule.start}:00 - ${schedule.end}:00` : '24/7'}`)
            .setColor(0x5865F2) // Blurple Discord
            .addFields({ name: '👥 Usuarios en Turno', value: '```\nNadie por ahora\n```' })
            .setFooter({ text: 'Sistema de Fichaje Profesional' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_start').setLabel('🟢 Entrar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_stop').setLabel('🔴 Salir').setStyle(ButtonStyle.Danger)
        );

        await dashCh.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: '✅ Configuración guardada y panel enviado.', ephemeral: true });
    }

    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const now = Date.now();
        const config = guildConfigs.get(guildId);

        if (!config) return interaction.reply({ content: '⚠️ El bot se reinició. Usa `!run` para reconfigurar.', ephemeral: true });

        if (interaction.customId === 'btn_start' && config.schedule) {
            const currentHour = momentTimezone.tz(config.timezone).hour();
            
            if (currentHour < config.schedule.start || currentHour >= config.schedule.end) {
                return interaction.reply({ 
                    content: `⛔ **Oficina Cerrada**\nEl horario de fichaje es de **${config.schedule.start}:00** a **${config.schedule.end}:00** (${config.timezone}).`, 
                    ephemeral: true 
                });
            }
        }

        if (interaction.customId === 'btn_start') {
            if (activeSessions.has(userId)) return interaction.reply({ content: '❌ Ya tienes un turno activo.', ephemeral: true });
            
            if (cooldowns.has(userId) && now < cooldowns.get(userId)) {
                 const expires = Math.floor(cooldowns.get(userId) / 1000);
                 return interaction.reply({ content: `⏳ **Cooldown activo.** Espera hasta <t:${expires}:R>.`, ephemeral: true });
            }

            activeSessions.set(userId, { startTime: now, guildId: guildId });
            
            const logCh = await client.channels.fetch(config.logId).catch(()=>null);
            if(logCh) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('🟢 Inicio de Turno')
                    .setDescription(`**Usuario:** <@${userId}>\n**Hora:** <t:${Math.floor(now/1000)}:f>`)
                    .setColor(0x57F287); // Verde Discord
                logCh.send({ embeds: [logEmbed] });
            }
            
            await updateDashboard(interaction, config.dashboardId);
            return interaction.reply({ content: '✅ **Turno iniciado correctamente.** ¡Buen trabajo!', ephemeral: true });
        }

        if (interaction.customId === 'btn_stop') {
            if (!activeSessions.has(userId)) return interaction.reply({ content: '❓ No has iniciado turno.', ephemeral: true });

            const session = activeSessions.get(userId);
            const durationMs = now - session.startTime;
            const duration = moment.duration(durationMs).format("h [h], m [min], s [seg]");

            const userEmbed = new EmbedBuilder()
                .setTitle('👋 Turno Finalizado')
                .setColor(0xED4245) // Rojo
                .addFields(
                    { name: '⏱️ Tiempo Trabajado', value: `**${duration}**`, inline: true },
                    { name: '📅 Inicio', value: `<t:${Math.floor(session.startTime/1000)}:t>`, inline: true },
                    { name: '📅 Fin', value: `<t:${Math.floor(now/1000)}:t>`, inline: true }
                );

            const logCh = await client.channels.fetch(config.logId).catch(()=>null);
            if(logCh) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('📕 Registro de Turno')
                    .setThumbnail(interaction.user.displayAvatarURL()) // Foto del usuario
                    .setColor(0xED4245)
                    .addFields(
                        { name: '👤 Usuario', value: `<@${userId}>`, inline: true },
                        { name: '⏳ Duración', value: `**${duration}**`, inline: true },
                        { name: 'clock', value: ' ', inline: false }, // Separador
                        { name: '🟢 Entrada', value: `<t:${Math.floor(session.startTime/1000)}:F>`, inline: true },
                        { name: '🔴 Salida', value: `<t:${Math.floor(now/1000)}:F>`, inline: true }
                    )
                    .setFooter({ text: 'Registro automático' })
                    .setTimestamp();
                await logCh.send({ embeds: [logEmbed] });
            }

            activeSessions.delete(userId);
            cooldowns.set(userId, now + (10*60*1000)); // 10 min cooldown
            await updateDashboard(interaction, config.dashboardId);
            
            return interaction.reply({ embeds: [userEmbed], ephemeral: true });
        }
    }
});

async function updateDashboard(interaction, channelId) {
    const channel = await interaction.guild.channels.fetch(channelId).catch(()=>null);
    if (!channel) return;

    let list = "";
    activeSessions.forEach((data, uId) => {
        if (data.guildId === interaction.guild.id) {
            list += `• <@${uId}> - <t:${Math.floor(data.startTime/1000)}:R>\n`;
        }
    });

    if (list === "") list = "```\nNadie por ahora\n```";

    const config = guildConfigs.get(interaction.guild.id);
    const embed = new EmbedBuilder()
        .setTitle('⏱️ Control de Asistencia')
        .setDescription(`**Estado:** Sistema Operativo\n**Zona Horaria:** ${config.timezone}\n**Horario:** ${config.schedule ? `${config.schedule.start}:00 - ${config.schedule.end}:00` : '24/7'}`)
        .setColor(0x5865F2)
        .addFields({ name: '👥 Usuarios en Turno', value: list })
        .setFooter({ text: 'Sistema de Fichaje Profesional' });

    const messages = await channel.messages.fetch({ limit: 10 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
    if (botMsg) await botMsg.edit({ embeds: [embed] });
}

client.login(process.env.DISCORD_TOKEN);
