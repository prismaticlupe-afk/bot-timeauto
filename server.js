const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    PermissionsBitField 
} = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot con Modales Activo.'));
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
const guildConfigs = new Map(); // Guarda: guildId -> { logChannelId }

client.on('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.content === '!run') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('❌ Solo administradores pueden usar esto.');
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_open_setup')
                    .setLabel('⚙️ Configurar Canales')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🛠️')
            );

        await message.reply({ 
            content: 'Haz clic en el botón para abrir la configuración e introducir los IDs.', 
            components: [row] 
        });
    }
});

client.on('interactionCreate', async (interaction) => {
    
    if (interaction.isButton() && interaction.customId === 'btn_open_setup') {
        const modal = new ModalBuilder()
            .setCustomId('setup_modal')
            .setTitle('Configuración del Sistema');

        const dashboardInput = new TextInputBuilder()
            .setCustomId('dashboard_id')
            .setLabel("ID del Canal para los Botones (Panel)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ej: 1445632878968045670')
            .setRequired(true);

        const logInput = new TextInputBuilder()
            .setCustomId('log_id')
            .setLabel("ID del Canal para Logs (Admin)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ej: 1445632878968045670')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(dashboardInput);
        const secondActionRow = new ActionRowBuilder().addComponents(logInput);

        modal.addComponents(firstActionRow, secondActionRow);
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'setup_modal') {
        const dashId = interaction.fields.getTextInputValue('dashboard_id');
        const logId = interaction.fields.getTextInputValue('log_id');

        await interaction.deferReply({ ephemeral: true });

        const dashboardChannel = await interaction.guild.channels.fetch(dashId).catch(() => null);
        const logChannel = await interaction.guild.channels.fetch(logId).catch(() => null);

        if (!dashboardChannel || !logChannel) {
            return interaction.editReply('❌ Error: Uno de los IDs no es válido o el bot no tiene acceso a esos canales.');
        }

        guildConfigs.set(interaction.guild.id, {
            dashboardChannel: dashId, // Guardamos ID
            logChannel: logId         // Guardamos ID
        });

        const embed = new EmbedBuilder()
            .setTitle('⏱️ Control de Tiempos')
            .setDescription('**Estado:** Sistema Listo.\nPresiona **🟢 Iniciar** para comenzar tu turno.')
            .setColor(0x2B2D31)
            .addFields({ name: 'Usuarios Activos', value: '*Nadie por ahora*' })
            .setFooter({ text: 'Sistema de Fichaje con Cooldown de 10 min' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_start')
                    .setLabel('🟢 Iniciar Turno')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('btn_stop')
                    .setLabel('🔴 Finalizar Turno')
                    .setStyle(ButtonStyle.Danger),
            );

        try {
            await dashboardChannel.send({ embeds: [embed], components: [row] });
            await interaction.editReply(`✅ **¡Configurado!**\nPanel enviado a: ${dashboardChannel}\nLogs se enviarán a: ${logChannel}`);
        } catch (error) {
            await interaction.editReply('❌ Error al enviar el mensaje al canal. Revisa los permisos del bot.');
        }
    }

    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const now = Date.now();
        const config = guildConfigs.get(guildId);

        if (!config) {
            return interaction.reply({ content: '⚠️ El sistema se reinició. Por favor, un admin debe usar `!run` de nuevo para reconfigurar.', ephemeral: true });
        }

        // 1. START
        if (interaction.customId === 'btn_start') {
            if (activeSessions.has(userId)) {
                return interaction.reply({ content: '❌ Ya tienes un turno activo.', ephemeral: true });
            }

            if (cooldowns.has(userId)) {
                const allowedTime = cooldowns.get(userId);
                if (now < allowedTime) {
                    return interaction.reply({ content: `⏳ Espera 10 min. Podrás abrir turno <t:${Math.floor(allowedTime/1000)}:R>.`, ephemeral: true });
                }
            }

            activeSessions.set(userId, { startTime: now, guildId: guildId });
            
            const logChannel = await client.channels.fetch(config.logChannel).catch(() => null);
            if (logChannel) logChannel.send(`🟢 **INICIO** | <@${userId}> (<t:${Math.floor(now/1000)}:f>)`);

            await updateDashboardEmbed(interaction, config.dashboardChannel);
            return interaction.reply({ content: '✅ Turno iniciado.', ephemeral: true });
        }

        if (interaction.customId === 'btn_stop') {
            if (!activeSessions.has(userId)) {
                return interaction.reply({ content: '❓ No tienes turno activo.', ephemeral: true });
            }

            const sessionData = activeSessions.get(userId);
            const durationMs = now - sessionData.startTime;
            const duration = moment.duration(durationMs).format("h [h], m [min], s [seg]");

            const logChannel = await client.channels.fetch(config.logChannel).catch(() => null);
            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('📕 Turno Finalizado')
                    .setColor(0xFF0000)
                    .addFields(
                        { name: 'Usuario', value: `<@${userId}>`, inline: true },
                        { name: 'Tiempo', value: `**${duration}**`, inline: true },
                        { name: 'Inicio', value: `<t:${Math.floor(sessionData.startTime / 1000)}:t>`, inline: true },
                        { name: 'Fin', value: `<t:${Math.floor(now / 1000)}:t>`, inline: true }
                    );
                await logChannel.send({ embeds: [logEmbed] });
            }

            const dashChannel = await client.channels.fetch(config.dashboardChannel).catch(() => null);
            if(dashChannel) {
                 dashChannel.send(`🔴 <@${userId}> cerró turno. Tiempo: **${duration}**.`)
                    .then(msg => setTimeout(() => msg.delete(), 10000));
            }

            cooldowns.set(userId, now + (10 * 60 * 1000)); // 10 min cooldown
            activeSessions.delete(userId);
            
            await updateDashboardEmbed(interaction, config.dashboardChannel);
            return interaction.reply({ content: `Has cerrado turno. Tiempo: **${duration}**.`, ephemeral: true });
        }
    }
});

async function updateDashboardEmbed(interaction, channelId) {
    
    const channel = await interaction.guild.channels.fetch(channelId).catch(()=>null);
    if(!channel) return;

    let activeUserList = [];
    activeSessions.forEach((data, uId) => {
        if (data.guildId === interaction.guild.id) {
            activeUserList.push(`<@${uId}> (Desde <t:${Math.floor(data.startTime / 1000)}:R>)`);
        }
    });
    const listText = activeUserList.length > 0 ? activeUserList.join('\n') : '*Nadie por ahora*';

    const newEmbed = new EmbedBuilder()
        .setTitle('⏱️ Control de Tiempos')
        .setDescription('**Estado:** Sistema Activo.')
        .setColor(0x2B2D31)
        .addFields({ name: 'Usuarios Activos', value: listText })
        .setFooter({ text: 'Sistema de Fichaje con Cooldown de 10 min' });

    if (interaction.message && interaction.message.author.id === client.user.id && interaction.message.embeds.length > 0) {
       await interaction.message.edit({ embeds: [newEmbed] });
    }
}

client.login(process.env.DISCORD_TOKEN);
