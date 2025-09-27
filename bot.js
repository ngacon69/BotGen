/**
 * @file Payout Bot - Phiên bản Mở rộng và Chuyên nghiệp
 * @description Một bot Discord mạnh mẽ để quản lý, phân phối và theo dõi kho tài khoản.
 * @version 3.0.0
 * @author YourName
 */

// =================================================================================================
// SECTION: IMPORTS & KHỞI TẠO BAN ĐẦU
// =================================================================================================

// Import các module cần thiết từ discord.js và các thư viện khác
const {
    Client, GatewayIntentBits, ActionRowBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder,
    SlashCommandBuilder, Routes, REST, Collection, ButtonBuilder,
    ButtonStyle, ChannelType
} = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();


// =================================================================================================
// SECTION: CẤU HÌNH TRUNG TÂM
// =================================================================================================

/**
 * @description Quản lý tập trung thông tin về các loại dịch vụ.
 * Việc này giúp dễ dàng thêm, sửa, xóa dịch vụ mà không cần thay đổi code ở nhiều nơi.
 * @type {Object.<string, {id: string, name: string, emoji: string}>}
 */
const SERVICE_CONFIG = {
    nfa: {
        id: 'nfa',
        name: 'Minecraft Non Full Access (NFA)',
        emoji: '⛏️',
    },
    fa: {
        id: 'fa',
        name: 'Minecraft Full Access (FA)',
        emoji: '💎',
    },
    xboxgp: {
        id: 'xboxgp',
        name: 'Xbox GamePass',
        emoji: '🎮',
    },
};

// Link hướng dẫn chung cho các dịch vụ cần Full Access
const FULL_ACCESS_LINK = 'https://drive.google.com/file/u/0/d/1X1H3vy1UKJPEv5kiBp60LBMCm4AktH29/view?pli=1';

// Cấu hình thời gian chờ (cooldown) cho lệnh /gen để tránh spam
const GEN_COOLDOWN_SECONDS = 300; // 5 phút


// =================================================================================================
// SECTION: KHỞI TẠO CLIENT & DATABASE
// =================================================================================================

// Khởi tạo Discord Client với các quyền (intents) cần thiết
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ]
});

// Sử dụng Collection để quản lý cooldown một cách hiệu quả
client.cooldowns = new Collection();

// Kết nối đến Database PostgreSQL
// Đảm bảo rằng biến DATABASE_URL trong file .env đã được cấu hình đúng.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});


// =================================================================================================
// SECTION: CÁC HÀM TƯƠNG TÁC VỚI DATABASE (Tầng dữ liệu)
// =================================================================================================

/**
 * @description Khởi tạo cấu trúc database, tạo các bảng cần thiết nếu chúng chưa tồn tại.
 * Bổ sung thêm bảng `transactions` để ghi log và cột `log_channel` để lưu kênh log.
 */
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id VARCHAR(255) PRIMARY KEY,
                payout_role VARCHAR(255) NOT NULL,
                log_channel VARCHAR(255)
            );
            
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                service_type VARCHAR(50) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(guild_id, service_type, email) -- Đảm bảo không có tài khoản trùng lặp
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(255) NOT NULL,
                user_id VARCHAR(255) NOT NULL,
                service_type VARCHAR(50) NOT NULL,
                account_email VARCHAR(255) NOT NULL,
                generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database schema is verified and up-to-date.');
    } catch (error) {
        console.error('FATAL: Could not initialize database! Exiting...', error);
        process.exit(1); // Dừng bot nếu không thể kết nối hoặc khởi tạo DB
    }
}

/**
 * @description Lấy thông tin cài đặt của một server (guild).
 * @param {string} guildId ID của server.
 * @returns {Promise<{payout_role: string, log_channel: string}|null>}
 */
async function getGuildSettings(guildId) {
    const result = await pool.query(
        'SELECT payout_role, log_channel FROM guild_settings WHERE guild_id = $1',
        [guildId]
    );
    return result.rows[0] || null;
}

/**
 * @description Lưu hoặc cập nhật cài đặt Payout Role cho server.
 * @param {string} guildId - ID của server.
 * @param {string} payoutRole - ID của role.
 */
async function setGuildSettings(guildId, payoutRole) {
    await pool.query(
        `INSERT INTO guild_settings (guild_id, payout_role) VALUES ($1, $2) 
         ON CONFLICT (guild_id) DO UPDATE SET payout_role = EXCLUDED.payout_role`,
        [guildId, payoutRole]
    );
}

/**
 * @description Lưu hoặc cập nhật cài đặt Kênh Log cho server.
 * @param {string} guildId - ID của server.
 * @param {string} logChannelId - ID của kênh log.
 */
async function setLogChannel(guildId, logChannelId) {
    await pool.query(
        `UPDATE guild_settings SET log_channel = $1 WHERE guild_id = $2`,
        [logChannelId, guildId]
    );
}

/**
 * @description Thêm nhiều tài khoản vào kho một lúc (bulk insert).
 * @param {string} guildId
 * @param {string} serviceType
 * @param {Array<{email: string, password: string}>} accounts
 * @returns {Promise<{successCount: number, failureCount: number}>}
 */
async function addMultipleAccounts(guildId, serviceType, accounts) {
    let successCount = 0;
    // Sử dụng transaction để đảm bảo tính toàn vẹn dữ liệu
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const account of accounts) {
            // ON CONFLICT DO NOTHING để bỏ qua các tài khoản đã tồn tại
            const res = await client.query(
                `INSERT INTO accounts (guild_id, email, password, service_type) 
                 VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, service_type, email) DO NOTHING`,
                [guildId, account.email, account.password, serviceType]
            );
            if (res.rowCount > 0) successCount++;
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e; // Ném lỗi ra ngoài để xử lý ở tầng trên
    } finally {
        client.release();
    }
    return { successCount, failureCount: accounts.length - successCount };
}

/**
 * @description Lấy và xóa một tài khoản ngẫu nhiên khỏi kho.
 * @returns {Promise<object|null>} Tài khoản được lấy hoặc null nếu hết hàng.
 */
async function getAndRemoveRandomAccount(guildId, serviceType) {
    const query = `
        DELETE FROM accounts
        WHERE id = (
            SELECT id FROM accounts
            WHERE guild_id = $1 AND service_type = $2
            ORDER BY RANDOM() LIMIT 1
        ) RETURNING *;`;
    const result = await pool.query(query, [guildId, serviceType]);
    return result.rows[0] || null;
}

/**
 * @description Đếm số lượng tài khoản trong kho.
 * @returns {Promise<Array<{service_type: string, count: string}>>}
 */
async function getStockCount(guildId) {
    const result = await pool.query(
        `SELECT service_type, COUNT(*) as count FROM accounts WHERE guild_id = $1 GROUP BY service_type`,
        [guildId]
    );
    return result.rows;
}

/**
 * @description Xóa TẤT CẢ tài khoản của một dịch vụ cụ thể.
 * @returns {Promise<number>} Số lượng tài khoản đã bị xóa.
 */
async function clearStockForService(guildId, serviceType) {
    const result = await pool.query(
        'DELETE FROM accounts WHERE guild_id = $1 AND service_type = $2',
        [guildId, serviceType]
    );
    return result.rowCount;
}

/**
 * @description Ghi lại giao dịch khi một tài khoản được tạo ra.
 */
async function addTransaction(guildId, userId, serviceType, accountEmail) {
    await pool.query(
        'INSERT INTO transactions (guild_id, user_id, service_type, account_email) VALUES ($1, $2, $3, $4)',
        [guildId, userId, serviceType, accountEmail]
    );
}

/**
 * @description Lấy thông tin thống kê cho bot.
 * @returns {Promise<{totalStock: number, totalGenerated: number}>}
 */
async function getBotStats(guildId) {
    const stockPromise = pool.query('SELECT COUNT(*) FROM accounts WHERE guild_id = $1', [guildId]);
    const generatedPromise = pool.query('SELECT COUNT(*) FROM transactions WHERE guild_id = $1', [guildId]);
    const [stockResult, generatedResult] = await Promise.all([stockPromise, generatedPromise]);
    return {
        totalStock: parseInt(stockResult.rows[0].count, 10),
        totalGenerated: parseInt(generatedResult.rows[0].count, 10)
    };
}


// =================================================================================================
// SECTION: HÀM TIỆN ÍCH & HỖ TRỢ
// =================================================================================================

/**
 * @description Kiểm tra quyền hạn Payout Role của người dùng.
 * @returns {Promise<boolean>} Trả về true nếu có quyền, ngược lại trả về false và tự động trả lời interaction.
 */
async function hasPayoutPermission(interaction) {
    // Quản trị viên luôn có quyền
    if (interaction.member.permissions.has('Administrator')) return true;

    const settings = await getGuildSettings(interaction.guild.id);
    if (!settings?.payout_role) {
        const errorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Lỗi: Chưa cài đặt').setDescription('Server này chưa được cài đặt. Vui lòng yêu cầu quản trị viên chạy lệnh `/setup`.');
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        return false;
    }

    if (!interaction.member.roles.cache.has(settings.payout_role)) {
        const errorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Lỗi: Không có quyền').setDescription(`Bạn không có quyền sử dụng lệnh này. Cần có role <@&${settings.payout_role}>.`);
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        return false;
    }
    return true;
}

/**
 * @description Gửi một tin nhắn log đến kênh đã được cấu hình.
 * @param {import('discord.js').Interaction} interaction
 * @param {EmbedBuilder} embed - Embed để gửi đi.
 */
async function sendLog(interaction, embed) {
    const settings = await getGuildSettings(interaction.guild.id);
    if (!settings?.log_channel) return;

    try {
        const logChannel = await interaction.guild.channels.fetch(settings.log_channel);
        if (logChannel && logChannel.isTextBased()) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error(`Could not send log to channel ${settings.log_channel} in guild ${interaction.guild.id}. It might have been deleted.`, error);
    }
}


// =================================================================================================
// SECTION: ĐĂNG KÝ SLASH COMMANDS
// =================================================================================================

const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Cài đặt hoặc cập nhật cấu hình bot payout cho server.')
        .setDMPermission(false)
        .setDefaultMemberPermissions('0') // Yêu cầu quyền Administrator
        .addChannelOption(option =>
            option.setName('log_channel')
                .setDescription('Tùy chọn: Kênh để ghi lại các hoạt động quan trọng của bot.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('addstock-bulk')
        .setDescription('Thêm hàng loạt tài khoản vào kho từ một danh sách.')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('service')
                .setDescription('Loại dịch vụ của các tài khoản cần thêm')
                .setRequired(true)
                .addChoices(...Object.values(SERVICE_CONFIG).map(s => ({ name: s.name, value: s.id }))))
        .addAttachmentOption(option =>
            option.setName('file')
                .setDescription('File .txt chứa danh sách tài khoản (định dạng email:password)')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('gen')
        .setDescription('Lấy một tài khoản ngẫu nhiên từ kho (yêu cầu Payout Role).')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('service')
                .setDescription('Chọn loại dịch vụ bạn muốn lấy')
                .setRequired(true)
                .addChoices(...Object.values(SERVICE_CONFIG).map(s => ({ name: s.name, value: s.id })))),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Kiểm tra số lượng tài khoản hiện có trong kho.')
        .setDMPermission(false),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Hiển thị thống kê hoạt động của bot trên server này.')
        .setDMPermission(false),
    new SlashCommandBuilder()
        .setName('clearstock')
        .setDescription('[Nguy hiểm] Xóa TẤT CẢ tài khoản của một dịch vụ khỏi kho.')
        .setDMPermission(false)
        .setDefaultMemberPermissions('0') // Yêu cầu quyền Administrator
        .addStringOption(option =>
            option.setName('service')
                .setDescription('Loại dịch vụ cần xóa toàn bộ tài khoản')
                .setRequired(true)
                .addChoices(...Object.values(SERVICE_CONFIG).map(s => ({ name: s.name, value: s.id }))))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);
        const data = await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID), // Cần CLIENT_ID
            { body: commands },
        );
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error('Fatal: Could not register slash commands!', error);
    }
}


// =================================================================================================
// SECTION: XỬ LÝ LỆNH (COMMAND HANDLERS)
// =================================================================================================

async function handleSetup(interaction) {
    const logChannel = interaction.options.getChannel('log_channel');

    const roleSelect = new StringSelectMenuBuilder()
        .setCustomId('payout_role_select')
        .setPlaceholder('Chọn một role để cấp quyền Payout')
        .addOptions(
            interaction.guild.roles.cache
                .filter(role => !role.managed && role.id !== interaction.guild.id)
                .map(role => ({ label: role.name, value: role.id }))
                .slice(0, 25)
        );

    const row = new ActionRowBuilder().addComponents(roleSelect);
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('⚙️ Cài đặt Bot Payout')
        .setDescription('Vui lòng chọn **Payout Role**. Những người có role này sẽ được phép sử dụng các lệnh `/gen`, `/addstock-bulk`, và `/stock`.');

    if (logChannel) {
        await setLogChannel(interaction.guild.id, logChannel.id);
        embed.addFields({ name: 'Kênh Log', value: `Hoạt động của bot sẽ được ghi lại tại ${logChannel}.` });
    }

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleAddStockBulk(interaction) {
    if (!await hasPayoutPermission(interaction)) return;
    
    await interaction.deferReply({ ephemeral: true });

    const serviceType = interaction.options.getString('service');
    const attachment = interaction.options.getAttachment('file');

    if (!attachment.name.endsWith('.txt')) {
        return interaction.editReply({ content: 'Lỗi: Vui lòng chỉ tải lên file có định dạng .txt.'});
    }

    try {
        const response = await fetch(attachment.url);
        const text = await response.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
        
        const accounts = lines.map(line => {
            const parts = line.split(':');
            if (parts.length < 2) return null;
            return { email: parts[0].trim(), password: parts.slice(1).join(':').trim() };
        }).filter(acc => acc && acc.email && acc.password);

        if (accounts.length === 0) {
            return interaction.editReply({ content: 'Không tìm thấy tài khoản hợp lệ nào trong file (định dạng `email:password`).' });
        }

        const { successCount, failureCount } = await addMultipleAccounts(interaction.guild.id, serviceType, accounts);
        
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Thêm hàng loạt thành công')
            .setDescription(`Đã xử lý **${lines.length}** dòng từ file.`)
            .addFields(
                { name: 'Thêm thành công', value: `**${successCount}** tài khoản`, inline: true },
                { name: 'Bỏ qua (trùng lặp)', value: `**${failureCount}** tài khoản`, inline: true }
            );
        await interaction.editReply({ embeds: [embed] });

        // Gửi log
        const logEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('📦 Stock Added (Bulk)')
            .setDescription(`**${interaction.user.tag}** đã thêm **${successCount}** tài khoản **${SERVICE_CONFIG[serviceType].name}**.`)
            .setTimestamp();
        await sendLog(interaction, logEmbed);

    } catch (error) {
        console.error('Error adding bulk stock:', error);
        await interaction.editReply({ content: 'Đã có lỗi xảy ra khi xử lý file của bạn.'});
    }
}

async function handleGen(interaction) {
    if (!await hasPayoutPermission(interaction)) return;
    
    const serviceType = interaction.options.getString('service');
    const service = SERVICE_CONFIG[serviceType];
    const cooldowns = client.cooldowns;

    if (!cooldowns.has(interaction.commandName)) {
        cooldowns.set(interaction.commandName, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(interaction.commandName);
    const cooldownAmount = GEN_COOLDOWN_SECONDS * 1000;

    if (timestamps.has(interaction.user.id)) {
        const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
        if (now < expirationTime) {
            const timeLeft = (expirationTime - now) / 1000;
            return interaction.reply({ content: `Vui lòng chờ **${timeLeft.toFixed(0)} giây** nữa trước khi sử dụng lại lệnh \`/gen\`.`, ephemeral: true });
        }
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

    await interaction.deferReply({ ephemeral: true });

    const account = await getAndRemoveRandomAccount(interaction.guild.id, serviceType);

    if (!account) {
        const errorEmbed = new EmbedBuilder().setColor(0xFFCC00).setTitle(`Hết hàng!`).setDescription(`Rất tiếc, dịch vụ **${service.name}** đã hết tài khoản. Vui lòng quay lại sau.`);
        return interaction.editReply({ embeds: [errorEmbed] });
    }
    
    // Ghi lại giao dịch VÀO DATABASE
    await addTransaction(interaction.guild.id, interaction.user.id, serviceType, account.email);

    const dmEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(`${service.emoji} Tài khoản ${service.name} của bạn`)
        .setDescription(`Đây là thông tin tài khoản bạn yêu cầu từ server **${interaction.guild.name}**.`)
        .addFields(
            { name: '📧 Email', value: `\`\`\`${account.email}\`\`\`` },
            { name: '🔑 Mật khẩu', value: `\`\`\`${account.password}\`\`\`` }
        )
        .setTimestamp()
        .setFooter({ text: 'Vui lòng không chia sẻ tài khoản này.' });
    
    if (service.id === 'fa' || service.id === 'xboxgp') {
        dmEmbed.addFields({ name: '🔗 Hướng dẫn Full Access', value: `[Nhấn vào đây](${FULL_ACCESS_LINK})` });
    }

    try {
        await interaction.user.send({ embeds: [dmEmbed] });
        const successEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Thành công!').setDescription(`Thông tin tài khoản **${service.name}** đã được gửi vào tin nhắn riêng của bạn.`);
        await interaction.editReply({ embeds: [successEmbed] });

        // Gửi log
        const logEmbed = new EmbedBuilder()
            .setColor(0xFFA500) // Orange
            .setTitle('🎁 Account Generated')
            .setDescription(`**${interaction.user.tag}** đã nhận một tài khoản **${service.name}**.`)
            .addFields({ name: 'Email', value: `||${account.email}||`})
            .setTimestamp();
        await sendLog(interaction, logEmbed);

    } catch (error) {
        console.error(`Could not send DM to ${interaction.user.tag}.`, error);
        const dmErrorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Lỗi gửi tin nhắn').setDescription('Tôi không thể gửi tin nhắn cho bạn. Vui lòng kiểm tra lại cài đặt quyền riêng tư của bạn.');
        await interaction.editReply({ embeds: [dmErrorEmbed] });
    }
}

async function handleStock(interaction) {
    if (!await hasPayoutPermission(interaction)) return;

    await interaction.deferReply({ ephemeral: true });
    const stockCounts = await getStockCount(interaction.guild.id);

    if (stockCounts.length === 0) {
        const embed = new EmbedBuilder().setColor(0xFFCC00).setTitle('Kho trống').setDescription('Hiện tại không có tài khoản nào trong kho.');
        return interaction.editReply({ embeds: [embed] });
    }

    const description = stockCounts
        .map(item => {
            const service = SERVICE_CONFIG[item.service_type];
            return `${service.emoji} ${service.name}: **${item.count}** tài khoản`;
        })
        .join('\n');

    const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('📊 Thống kê kho tài khoản').setDescription(description).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction) {
    if (!await hasPayoutPermission(interaction)) return;
    await interaction.deferReply({ ephemeral: true });

    const stats = await getBotStats(interaction.guild.id);
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📈 Thống kê Bot cho ${interaction.guild.name}`)
        .addFields(
            { name: '📦 Tổng tài khoản trong kho', value: `**${stats.totalStock}**`, inline: true },
            { name: '🎁 Tổng tài khoản đã phát', value: `**${stats.totalGenerated}**`, inline: true },
            { name: 'Uptime', value: `${Math.floor(client.uptime / 3600000)} giờ ${Math.floor((client.uptime % 3600000) / 60000)} phút`, inline: true}
        )
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

async function handleClearStock(interaction) {
    const serviceType = interaction.options.getString('service');
    const service = SERVICE_CONFIG[serviceType];

    const confirmButton = new ButtonBuilder().setCustomId(`confirm_clear_${serviceType}`).setLabel('Đồng ý Xóa!').setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder().setCustomId('cancel_clear').setLabel('Hủy').setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle(`⚠️ XÁC NHẬN HÀNH ĐỘNG NGUY HIỂM ⚠️`)
        .setDescription(`Bạn có chắc chắn muốn **XÓA TẤT CẢ** tài khoản **${service.name}** khỏi kho không? Hành động này **KHÔNG THỂ** hoàn tác!`);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}


// =================================================================================================
// SECTION: LẮNG NGHE SỰ KIỆN (EVENT LISTENERS)
// =================================================================================================

client.once('ready', async () => {
    if (!process.env.CLIENT_ID) {
        console.error('FATAL: CLIENT_ID is not defined in .env file!');
        process.exit(1);
    }
    console.log(`Logged in as ${client.user.tag}!`);
    await initializeDatabase();
    await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const commandHandlers = {
                'setup': handleSetup,
                'addstock-bulk': handleAddStockBulk,
                'gen': handleGen,
                'stock': handleStock,
                'stats': handleStats,
                'clearstock': handleClearStock,
            };
            if (commandHandlers[interaction.commandName]) {
                await commandHandlers[interaction.commandName](interaction);
            }
        } else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'payout_role_select') {
                await interaction.deferUpdate();
                const roleId = interaction.values[0];
                await setGuildSettings(interaction.guild.id, roleId);
                const successEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Cài đặt thành công').setDescription(`Role Payout đã được cập nhật thành <@&${roleId}>.`);
                await interaction.editReply({ embeds: [successEmbed], components: [] });
            }
        } else if (interaction.isButton()) {
            if (interaction.customId.startsWith('confirm_clear_')) {
                const serviceType = interaction.customId.replace('confirm_clear_', '');
                const service = SERVICE_CONFIG[serviceType];
                const deletedCount = await clearStockForService(interaction.guild.id, serviceType);

                const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Hoàn tất').setDescription(`Đã xóa thành công **${deletedCount}** tài khoản **${service.name}**.`);
                await interaction.update({ embeds: [embed], components: [] });

                // Gửi log
                const logEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('🗑️ Stock Cleared').setDescription(`**${interaction.user.tag}** đã xóa **${deletedCount}** tài khoản **${service.name}**.`).setTimestamp();
                await sendLog(interaction, logEmbed);

            } else if (interaction.customId === 'cancel_clear') {
                const embed = new EmbedBuilder().setColor(0xAAAAAA).setTitle('Hủy bỏ').setDescription('Hành động xóa kho đã được hủy.');
                await interaction.update({ embeds: [embed], components: [] });
            }
        }
    } catch (error) {
        console.error('An error occurred during interaction processing:', error);
        const errorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('💥 Đã xảy ra lỗi').setDescription('Đã có lỗi không mong muốn xảy ra. Vui lòng thử lại sau.');
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }
    }
});


// =================================================================================================
// SECTION: ĐĂNG NHẬP BOT
// =================================================================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error("FATAL: DISCORD_TOKEN is not defined in .env file. Bot cannot start.");
    process.exit(1);
}
client.login(token);

