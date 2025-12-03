const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const moment = require('moment');
require('moment-duration-format');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('El bot está activo. Monitorizando tiempos...');
});

app.listen(port, () => {
  console.log(`Servidor web activo en puerto ${port}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const activeSessions = new Map(); // Memoria temporal de usuarios activos

const LOG_CHANNEL_ID = '1445632878968045670'; 

client.on('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.content === '!setuptime') {
        message.delete().catch(()=> {});

        const embed = new EmbedBuilder()
            .setTitle('⏱️ Control de Tiempos y Fichaje')
            .setDescription('**Estado:** Nadie está contando tiempo ahora mismo.')
            .setColor(0x0099FF)
            .setFooter({ text: 'Sistema automático. Presiona el botón para iniciar.' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_start')
                    .setLabel('🟢 Tomar Time')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('btn_stop')
                    .setLabel('🔴 Cerrar Time')
                    .setStyle(ButtonStyle.Danger),
            );

        await message.channel.send({ embeds: [embed], components: [row] });
    }
});

async function updateDashboard(interaction) {
    let description = "**Usuarios actualmente en turno:**\n\n";
    
    if (activeSessions.size === 0) {
        description += "*Nadie está activo.*";
    } else {
        activeSessions.forEach((startTime, userId) => {
            // <t:X:R> muestra el tiempo relativo (ej: "hace 10 minutos") en la zona horaria de quien lo lee
            description += `• <@${userId}> (Desde <t:${Math.floor(startTime / 1000)}:R>)\n`;
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('⏱️ Control de Tiempos y Fichaje')
        .setDescription(description)
        .setColor(0x0099FF)
        .setFooter({ text: 'Sistema automático de control de horas' });

    await interaction.message.edit({ embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const userId = interaction.user.id;
    const now = Date.now();

    if (interaction.customId === 'btn_start') {
        if (activeSessions.has(userId)) {
            return interaction.reply({ content: '¡Ya tienes un reloj activo!', ephemeral: true });
        }

        activeSessions.set(userId, now);
        await updateDashboard(interaction);
        return interaction.reply({ content: 'Has iniciado tu turno.', ephemeral: true });
    }

    // 2. CERRAR TURNO
    if (interaction.customId === 'btn_stop') {
        if (!activeSessions.has(userId)) {
            return interaction.reply({ content: 'No tienes ningún turno activo.', ephemeral: true });
        }

        const startTime = activeSessions.get(userId);
        const durationMs = now - startTime;
        
        // Formatear duración (Ej: "2h 30m 15s")
        const duration = moment.duration(durationMs).format("h [h], m [min], s [seg]");
        
        // ENVIAR REPORTE AL CANAL CONFIGURADO (ID 14456...)
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle('📝 Registro de Turno')
                .setColor(0xFFA500)
                .addFields(
                    { name: 'Usuario', value: `<@${userId}>`, inline: true },
                    { name: 'Tiempo Total', value: `**${duration}**`, inline: true },
                    { name: 'Inicio', value: `<t:${Math.floor(startTime / 1000)}:f>`, inline: true }, // Hora exacta global
                    { name: 'Fin', value: `<t:${Math.floor(now / 1000)}:f>`, inline: true }
                )
                .setTimestamp();
            
            await logChannel.send({ embeds: [logEmbed] });
        }

        activeSessions.delete(userId);
        await updateDashboard(interaction);
        
        return interaction.reply({ content: `Has cerrado turno. Tiempo: **${duration}**.`, ephemeral: true });
    }
});

// ¡IMPORTANTE! NO PONER EL TOKEN AQUÍ. LO LEERÁ DE RENDER.
client.login(process.env.DISCORD_TOKEN);
