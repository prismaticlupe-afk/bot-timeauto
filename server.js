const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, 
    PermissionsBitField, ActivityType 
} = require('discord.js');
const express = require('express');
const moment = require('moment');
const fs = require('fs');
require('moment-duration-format');
const momentTimezone = require('moment-timezone');

// --- SERVIDOR WEB ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot V10.2 Explicativo Activo.'));

app.get('/ping', (req, res) => {
    res.status(200).send('Pong! 🏓');
});
// -------------------------------

app.listen(port, () => console.log(`Web lista en puerto ${port}`));

// --- CLIENTE DISCORD ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    presence: { status: 'online', activities: [{ name: 'Ayuda: !guia', type: 3 }] }
});

// --- MEMORIA ---
let localConfig = {}; 
let sessions = {};    
let frozenStates = {};
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
// 🚀 INICIO CON AUTO-RESTAURACIÓN
// ==========================================
client.on('ready', async () => {
    console.log(`🤖 Bot Conectado: ${client.user.tag}`);
    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
        const config = await recoverConfig(guild);
        if (config) await restoreSessionsFromChat(guild, config);
    }
    console.log("✅ Restauración completada.");
    setInterval(checkAutoSchedules, 60000);
});

// --- FUNCIÓN DE RESTAURACIÓN ---
async function restoreSessionsFromChat(guild, config) {
    const logChannel = await guild.channels.fetch(config.logId).catch(() => null);
    if (!logChannel) return;

    const messages = await logChannel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;

    const processedUsers = new Set(); 

    for (const msg of messages.values()) {
        if (msg.author.id !== client.user.id || msg.embeds.length === 0) continue;
        const embed = msg.embeds[0];
        
        let userId = null;
        const descMatch = embed.description?.match(/<@(\d+)>/);
        const fieldMatch = embed.fields?.[0]?.value?.match(/<@(\d+)>/);
        
        if (descMatch) userId = descMatch[1];
        else if (fieldMatch) userId = fieldMatch[1];

        if (!userId || processedUsers.has(userId)) continue; 

        const isStart = embed.description?.includes('iniciado turno');
        
        if (isStart) {
            sessions[userId] = {
                start: msg.createdTimestamp,
                guildId: guild.id,
                startMsgId: msg.id
            };
        }
        processedUsers.add(userId);
    }
    updateDash(guild.id);
}


// ==========================================
// 🛡️ SEGURIDAD Y CONFIG
// ==========================================
function isRateLimited(userId) {
    const now = Date.now();
    const last = rateLimits.get(userId);
    if (last && (now - last < SPAM_COOLDOWN)) return true;
    rateLimits.set(userId, now);
    return false;
}

async function saveConfigToChannel(guild, config) {
    const channel = await guild.channels.fetch(config.dashId).catch(() => null);
    if (!channel) return { success: false, error: 'El Canal ID Botones no existe' };
    
    const logCheck = await guild.channels.fetch(config.logId).catch(() => null);
    if (!logCheck) return { success: false, error: 'El Canal ID Logs no existe' };

    const configString = JSON.stringify(config);
    const secretTopic = `🔒 CONFIG_BOT [${configString}] (No borrar descripción)`;
    try {
        await channel.setTopic(secretTopic);
        localConfig[guild.id] = config;
        return { success: true };
    } catch (e) { return { success: false, error: 'Falta permiso "Gestionar Canal"' }; }
}

async function recoverConfig(guild) {
    if (localConfig[guild.id]) return localConfig[guild.id];
    const channels = await guild.channels.fetch().catch(()=>new Map());
    for (const channel of channels.values()) {
        if (channel.topic && channel.topic.includes('🔒 CONFIG_BOT')) {
            try {
                const raw = channel.topic.match(/\[(.*?)\]/)[1];
                const rec = JSON.parse(raw);
                localConfig[guild.id] = rec;
                return rec;
            } catch (e) {}
        }
    }
    return null; 
}

// ==========================================
// 📊 LÓGICA DE TIEMPO
// ==========================================
async function calculateTotalFromLogs(guildId, userId, logChannelId) {
    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!channel) return 0;
    let totalMs = 0; let keep = true; let lastId; let loops = 0;
    while (keep && loops < 10) { 
        const messages = await channel.messages.fetch({ limit: 100, before: lastId });
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
            if (msg.content.includes("✂️ CORTE DE CAJA")) { keep = false; break; }
            if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                const embed = msg.embeds[0];
                const uRef = `<@${userId}>`;
                if ((embed.description?.includes(uRef)) || (embed.fields?.some(f => f.value.includes(uRef)))) {
                    const tField = embed.fields.find(f => f.name.includes("Sesión") || f.name.includes("Tiempo") || f.name.includes("Duración"));
                    if (tField) totalMs += parseDurationToMs(tField.value.replace(/\*/g, '').trim());
                }
            }
            lastId = msg.id;
        }
        loops++;
    }
    return totalMs;
}

async function clearUserLogs(logChannel, userId) {
    let count = 0; let keep = true; let lastId; let loops = 0;
    while (keep && loops < 10) {
        const msgs = await logChannel.messages.fetch({limit:100, before:lastId});
        if(msgs.size===0) break;
        for(const m of msgs.values()){
            if(m.author.id===client.user.id && m.embeds.length>0){
                 const u = `<@${userId}>`;
                 if((m.embeds[0].description?.includes(u)) || (m.embeds[0].fields?.some(f=>f.value.includes(u)))) {
                     try{ await m.delete(); count++; await new Promise(r=>setTimeout(r,500)); }catch(e){}
                 }
            }
            lastId = m.id;
        }
        loops++;
    }
    return count;
}

function parseDurationToMs(s){ let ms=0; const r=/(\d+)\s*(h|m|s)/g; let m; while((m=r.exec(s))!==null){ const v=parseInt(m[1]); if(m[2]=='h')ms+=v*3600000; if(m[2]=='m')ms+=v*60000; if(m[2]=='s')ms+=v*1000; } return ms; }

// ==========================================
// 💬 COMANDOS
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // --- COMANDO GUÍA ACTUALIZADO Y EXPLÍCITO ---
    if (message.content === '!guide' || message.content === '!guia') {
        const guideEmbed = new EmbedBuilder()
            .setTitle('📘 Manual del Bot de Asistencia')
            .setDescription('**¿Qué es este bot?**\nEs un "Reloj Checador". Sirve para que tu equipo registre sus horas de trabajo automáticamente usando botones.')
            .setColor(0xFEE75C)
            .addFields(
                { name: '1. ¿Cómo funciona?', value: 'El bot publicará un panel con dos botones:\n🟢 **Entrar:** Inicia el cronómetro del turno.\n🔴 **Salir:** Detiene el cronómetro y guarda el tiempo trabajado en el historial.' },
                { name: '2. Preparar Canales', value: 'Necesitas crear 2 canales de texto:\n`#fichar` (Donde pondremos el panel con los botones).\n`#logs` (Donde se guardará el historial de horas).' },
                { name: '3. Obtener IDs (Importante)', value: 'Para configurar, necesitas las "IDs" de esos canales:\n- Ve a Ajustes -> Avanzado -> **Activa Modo Desarrollador**.\n- Clic derecho en `#fichar` -> Copiar ID.\n- Clic derecho en `#logs` -> Copiar ID.' },
                { name: '4. Instalación Final', value: 'Escribe `!run`. El bot te pedirá la Zona Horaria, Roles de Jefe y que pegues las IDs que copiaste en el paso anterior.' }
            )
            .setFooter({ text: 'Usa !run cuando tengas los canales listos.' });
        return message.reply({ embeds: [guideEmbed] });
    }

    if (message.content === '!help') {
        return message.reply({ embeds: [new EmbedBuilder().setTitle('Ayuda').setColor(0x5865F2).addFields({ name: 'Comandos', value: '`!guia` (Explica qué es el bot y cómo usarlo)\n`!run` (Instala el panel de botones)\n`!time @Usuario` (Ve cuánto ha trabajado alguien)\n`!corte` (Limpia el historial)' })] });
    }

    if (message.content === '!run') {
        if (message.author.id !== message.guild.ownerId) return message.reply('❌ Solo el Dueño del servidor (Owner) puede usar esto.');
        message.delete().catch(()=>{});
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sys_setup_trigger').setLabel('⚙️ Iniciar Instalación').setStyle(ButtonStyle.Success));
        const msg = await message.channel.send({ content: `👋 **Menú de Instalación**\n¿Ya leíste la guía (`+`!guia`+`)?\nTen a mano las IDs de tus canales.`, components: [row] });
        setTimeout(() => msg.delete().catch(()=>{}), 60000);
        return;
    }

    if (message.content === '!corte') {
        let config = localConfig[message.guild.id] || await recoverConfig(message.guild);
        if (!config) return message.reply('⚠️ Bot no configurado.');
        const ar = config.adminRoles || [];
        const isAdm = message.member.roles.cache.some(r => ar.includes(r.id)) || message.author.id === message.guild.ownerId;
        if (!isAdm) return message.reply('⛔ Sin permiso.');

        const logCh = await client.channels.fetch(config.logId).catch(()=>null);
        if (logCh) {
            await logCh.send('✂️ CORTE DE CAJA | -----------------------------------');
            await logCh.send(`> *Corte realizado por: ${message.author}* (El tiempo anterior ya no cuenta para el pago/reporte)`);
            message.reply('✅ Corte marcado correctamente.');
        }
    }

    if (message.content.startsWith('!time')) {
        let config = localConfig[message.guild.id] || await recoverConfig(message.guild);
        if (!config) return message.reply('⚠️ Bot no configurado.');
        const ar = config.adminRoles || [];
        const isAdm = message.member.roles.cache.some(r => ar.includes(r.id)) || message.author.id === message.guild.ownerId;
        if (!isAdm) return message.reply('⛔ Sin permiso.');

        const target = message.mentions.users.first();
        if (!target) return message.reply('⚠️ Menciona al usuario: `!time @Juan`');

        await message.channel.sendTyping();
        const tMs = await calculateTotalFromLogs(message.guild.id, target.id, config.logId);
        const tStr = moment.duration(tMs).format("h[h] m[m]");
        const emb = new EmbedBuilder().setTitle(`⏱️ Reporte: ${target.username}`).addFields({ name: 'Tiempo Acumulado', value: `**${tStr}**` }).setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_accumulate_${target.id}`).setLabel('Resetear a 0').setStyle(ButtonStyle.Success).setEmoji('📥'));
        await message.reply({ embeds: [emb], components: [row] });
    }
});

// ==========================================
// 🖱️ INTERACCIONES
// ==========================================
const tempSetup = new Map();

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && isRateLimited(interaction.user.id)) return interaction.reply({ content: '⏳ Espera...', ephemeral: true });

    if (!localConfig[interaction.guild.id] && !interaction.customId.startsWith('sys_') && !interaction.customId.startsWith('setup_')) {
        await recoverConfig(interaction.guild);
    }

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
        // ETIQUETAS EXPLÍCITAS
        m.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dash').setLabel("ID del Canal BOTONES (Donde se ficha)").setPlaceholder("Ej: 129384...").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log').setLabel("ID del Canal HISTORIAL (Donde se guarda)").setPlaceholder("Ej: 938475...").setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto').setLabel("Auto-Cierre (Opcional)").setPlaceholder("Ej: lunes 23:59 (O dejar vacío)").setStyle(TextInputStyle.Short).setRequired(false))
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
        const newConfig = { dashId, logId, timezone: pre.timezone, adminRoles: pre.adminRoles, autoCut };
        const res = await saveConfigToChannel(interaction.guild, newConfig);
        const ch = await interaction.guild.channels.fetch(dashId).catch(()=>null);
        if (ch) sendDashboard(ch, interaction.guild.id);
        if(res.success) await interaction.reply({ content: '✅ **Instalación Correcta**. Panel enviado al canal elegido.', ephemeral: true });
        else await interaction.reply({ content: `⚠️ Error: ${res.error}.`, ephemeral: true });
    }

    // ACUMULAR
    if (interaction.isButton() && interaction.customId.startsWith('btn_accumulate_')) {
        const targetId = interaction.customId.split('_')[2];
        const conf = localConfig[interaction.guild.id];
        if(!conf) return interaction.reply({content:'⚠️ Espera...', ephemeral:true});
        const isAdmin = interaction.member.roles.cache.some(r=>(conf.adminRoles||[]).includes(r.id)) || interaction.user.id===interaction.guild.ownerId;
        if(!isAdmin) return interaction.reply({content:'⛔ Solo Admins.', ephemeral:true});
        await interaction.reply({content:'⏳ Reseteando...', ephemeral:true});
        const ch = await client.channels.fetch(conf.logId).catch(()=>null);
        if(ch){
            const n = await clearUserLogs(ch, targetId);
            await interaction.editReply(`✅ Reset completo. Borrados: ${n}`);
        } else interaction.editReply('❌ No logs.');
    }

    // START / STOP
    if (interaction.isButton() && (interaction.customId === 'btn_start' || interaction.customId === 'btn_stop')) {
        const uId = interaction.user.id;
        const gId = interaction.guild.id;
        const conf = localConfig[gId];
        if(!conf) return interaction.reply({content:'⚠️ Reiniciando memoria...', ephemeral:true});

        if(interaction.customId==='btn_start'){
            if(frozenStates[gId]) return interaction.reply({content:'❄️ Sistema cerrado.', ephemeral:true});
            if(sessions[uId]) return interaction.reply({content:'❌ Ya estás dentro.', ephemeral:true});
            const ch = await client.channels.fetch(conf.logId).catch(()=>null);
            let mId = null;
            if(ch){ const m = await ch.send({embeds:[new EmbedBuilder().setDescription(`🟢 <@${uId}> ha iniciado turno.`).setColor(0x57F287)]}); mId = m.id; }
            sessions[uId] = { start: Date.now(), guildId: gId, startMsgId: mId };
            updateDash(gId);
            return interaction.reply({content:'✅ Turno iniciado. (Botón Verde)', ephemeral:true});
        }

        if(interaction.customId==='btn_stop'){
            if(!sessions[uId]) return interaction.reply({content:'❓ No has entrado.', ephemeral:true});
            await interaction.deferReply({ephemeral:true});
            const s = sessions[uId];
            const now = Date.now();
            const dur = now - s.start;
            const ch = await client.channels.fetch(conf.logId).catch(()=>null);
            if(ch && s.startMsgId) try{ await ch.messages.delete(s.startMsgId); }catch(e){}
            const hist = await calculateTotalFromLogs(gId, uId, conf.logId);
            const tot = hist + dur;
            if(ch){
                const emb = new EmbedBuilder().setTitle('📕 Turno Cerrado').addFields({name:'Usuario', value:`<@${uId}>`, inline:true},{name:'Sesión', value:`**${moment.duration(dur).format("h[h] m[m]")}**`, inline:true},{name:'Total', value:`**${moment.duration(tot).format("h[h] m[m]")}**`, inline:true}).setColor(0xED4245).setTimestamp();
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`btn_accumulate_${uId}`).setLabel('Resetear').setStyle(ButtonStyle.Secondary).setEmoji('📥'));
                await ch.send({embeds:[emb], components:[btn]});
            }
            delete sessions[uId];
            updateDash(gId);
            return interaction.editReply(`👋 Cerrado (Botón Rojo).\nSesión: **${moment.duration(dur).format("h[h] m[m]")}**`);
        }
    }
});

// AUXILIARES
async function sendDashboard(channel, guildId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_start').setLabel('ENTRAR').setStyle(ButtonStyle.Success).setEmoji('🟢'),
        new ButtonBuilder().setCustomId('btn_stop').setLabel('SALIR').setStyle(ButtonStyle.Danger).setEmoji('🔴')
    );
    const emb = new EmbedBuilder()
        .setTitle('⏱️ Control de Asistencia')
        .setDescription('**¿Cómo usarlo?**\nPresiona los botones para registrar tu actividad:\n\n🟢 **ENTRAR:** Inicia tu turno.\n🔴 **SALIR:** Termina tu turno y guarda el tiempo.')
        .setColor(0x5865F2)
        .addFields({ name: 'Activos Ahora', value: '*Nadie*' });
    await channel.send({ embeds: [emb], components: [row] });
}

async function updateDash(gId){
    const c = localConfig[gId]; if(!c)return;
    const ch = await client.channels.fetch(c.dashId).catch(()=>null); if(!ch)return;
    let l=[]; for(const u in sessions) if(sessions[u].guildId===gId) l.push(`• <@${u}> (<t:${Math.floor(sessions[u].start/1000)}:R>)`);
    const emb = new EmbedBuilder().setTitle('⏱️ Control de Asistencia').setDescription(`**Estado:** ${frozenStates[gId]?'❄️ Cerrado':'🟢 Activo'}`).setColor(frozenStates[gId]?0x99AAB5:0x5865F2).addFields({name:'Activos Ahora', value:l.length?l.join('\n'):'*Nadie*'});
    const ms = await ch.messages.fetch({limit:10});
    const b = ms.find(m=>m.author.id===client.user.id && m.components.length>0);
    if(b) b.edit({embeds:[emb]});
}

async function checkAutoSchedules() {
    for(const gId in localConfig){
        const c = localConfig[gId]; if(!c.autoCut || frozenStates[gId]) continue;
        const tz = momentTimezone.tz(c.timezone);
        const map = {'domingo':'Sunday','lunes':'Monday','martes':'Tuesday','miercoles':'Wednesday','jueves':'Thursday','viernes':'Friday','sabado':'Saturday'};
        const day = c.autoCut.day.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if(tz.format('dddd')===map[day] && tz.format('HH:mm')===c.autoCut.time){
            frozenStates[gId]=true;
            const ch = await client.channels.fetch(c.logId).catch(()=>null);
            for(const u in sessions){
                if(sessions[u].guildId===gId){ if(ch) ch.send({embeds:[new EmbedBuilder().setDescription(`⚠️ Auto-Cierre <@${u}>`).setColor(0xFFA500)]}); delete sessions[u]; }
            }
            updateDash(gId);
        }
    }
}

process.on('SIGTERM', () => process.exit(0));
client.login(process.env.DISCORD_TOKEN);
