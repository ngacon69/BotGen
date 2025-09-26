const { Client, GatewayIntentBits, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, Routes, REST, Collection, Events } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// Thêm collection cho prefix commands
client.commands = new Collection();

// Kết nối PostgreSQL (bắt buộc)
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is required in .env file!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database initialization
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id VARCHAR(20) PRIMARY KEY,
                payout_role VARCHAR(20)
            );
            
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(20),
                email VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                service_type VARCHAR(10) NOT NULL CHECK (service_type IN ('nfa', 'fa', 'xboxgp')),
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
        process.exit(1);
    }
}

// Helper functions để xử lý storage
async function getGuildSettings(guildId) {
    try {
        const result = await pool.query(
            'SELECT payout_role FROM guild_settings WHERE guild_id = $1',
            [guildId]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function setGuildSettings(guildId, payoutRole) {
    try {
        await pool.query(
            `INSERT INTO guild_settings (guild_id, payout_role) 
             VALUES ($1, $2) 
             ON CONFLICT (guild_id) 
             DO UPDATE SET payout_role = $2`,
            [guildId, payoutRole]
        );
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function addAccount(guildId, email, password, serviceType) {
    try {
        const result = await pool.query(
            `INSERT INTO accounts (guild_id, email, password, service_type) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [guildId, email, password, serviceType]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function getRandomAccount(guildId, serviceType) {
    try {
        const result = await pool.query(
            `SELECT * FROM accounts 
             WHERE guild_id = $1 AND service_type = $2 AND used = FALSE 
             ORDER BY RANDOM() LIMIT 1`,
            [guildId, serviceType]
        );
        
        if (result.rows.length > 0) {
            // Xóa account khỏi database
            await pool.query(
                'DELETE FROM accounts WHERE id = $1',
                [result.rows[0].id]
            );
            return result.rows[0];
        }
        return null;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function getStockCount(guildId) {
    try {
        const result = await pool.query(
            `SELECT service_type, COUNT(*) as count 
             FROM accounts 
             WHERE guild_id = $1 AND used = FALSE 
             GROUP BY service_type`,
            [guildId]
        );
        return result.rows;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Setup the payout system for this server'),
    
    new SlashCommandBuilder()
        .setName('addstock')
        .setDescription('Add accounts to the stock (Payout Role only)'),
    
    new SlashCommandBuilder()
        .setName('gen')
        .setDescription('Generate a random account (Payout Role only)')
        .addStringOption(option =>
            option.setName('service')
                .setDescription('Select service type')
                .setRequired(true)
                .addChoices(
                    { name: 'Minecraft Non Full Access (NFA)', value: 'nfa' },
                    { name: 'Minecraft Full Access (FA)', value: 'fa' },
                    { name: 'Xbox GamePass', value: 'xboxgp' }
                )
        ),
    
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Check current stock count')
];

// Định nghĩa prefix commands
const prefixCommands = {
    'stock': {
        description: 'Check current stock count',
        execute: handleStockCommand
    }
};

// Hàm xử lý prefix command stock
async function handleStockCommand(message) {
    try {
        const guildSettings = await getGuildSettings(message.guild.id);

        if (!guildSettings) {
            return message.reply('❌ Please run `/setup` first!');
        }

        const payoutRole = guildSettings.payout_role;
        if (!message.member.roles.cache.has(payoutRole)) {
            return message.reply('❌ You do not have permission to use this command!');
        }

        const stockCount = await getStockCount(message.guild.id);
        
        if (stockCount.length === 0) {
            return message.reply('❌ No accounts in stock! Use `/addstock` to add accounts.');
        }

        let stockMessage = '**📊 Current Stock:**\n';
        stockCount.forEach(item => {
            let serviceName = '';
            if (item.service_type === 'nfa') serviceName = 'Minecraft Non Full Access (NFA)';
            else if (item.service_type === 'fa') serviceName = 'Minecraft Full Access (FA)';
            else if (item.service_type === 'xboxgp') serviceName = 'Xbox GamePass';
            
            stockMessage += `• ${serviceName}: ${item.count} accounts\n`;
        });

        await message.reply(stockMessage);
    } catch (error) {
        console.error('Error in stock command:', error);
        await message.reply('❌ Database error occurred while checking stock.');
    }
}

async function registerCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered successfully');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

// Setup command
async function handleSetup(interaction) {
    try {
        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('payout_role_select')
            .setPlaceholder('Select payout role')
            .addOptions(
                ...interaction.guild.roles.cache
                    .filter(role => role.id !== interaction.guild.id)
                    .map(role => ({
                        label: role.name,
                        value: role.id
                    }))
                    .slice(0, 25)
            );

        const row = new ActionRowBuilder().addComponents(roleSelect);

        await interaction.reply({
            content: '**Payout Bot Setup**\nSelect the role that can use payout commands:',
            components: [row],
            flags: 64
        });
    } catch (error) {
        console.error('Error in setup command:', error);
        await interaction.reply({
            content: '❌ An error occurred while setting up.',
            flags: 64
        });
    }
}

// Addstock command
async function handleAddStock(interaction) {
    try {
        const guildSettings = await getGuildSettings(interaction.guild.id);

        if (!guildSettings) {
            return interaction.reply({
                content: '❌ Please run `/setup` first!',
                flags: 64
            });
        }

        const payoutRole = guildSettings.payout_role;
        if (!interaction.member.roles.cache.has(payoutRole)) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command!',
                flags: 64
            });
        }

        const modal = new ModalBuilder()
            .setCustomId('addstock_modal')
            .setTitle('Add Account to Stock');

        const emailInput = new TextInputBuilder()
            .setCustomId('email_input')
            .setLabel('Email')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const passwordInput = new TextInputBuilder()
            .setCustomId('password_input')
            .setLabel('Password')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const serviceInput = new TextInputBuilder()
            .setCustomId('service_input')
            .setLabel('Service Type (nfa, fa, or xboxgp)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(emailInput);
        const secondActionRow = new ActionRowBuilder().addComponents(passwordInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(serviceInput);

        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

        await interaction.showModal(modal);
    } catch (error) {
        console.error('Error in addstock command:', error);
        await interaction.reply({
            content: '❌ Database error occurred.',
            flags: 64
        });
    }
}

// Stock command (slash command)
async function handleStock(interaction) {
    try {
        const guildSettings = await getGuildSettings(interaction.guild.id);

        if (!guildSettings) {
            return interaction.reply({
                content: '❌ Please run `/setup` first!',
                flags: 64
            });
        }

        const payoutRole = guildSettings.payout_role;
        if (!interaction.member.roles.cache.has(payoutRole)) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command!',
                flags: 64
            });
        }

        const stockCount = await getStockCount(interaction.guild.id);
        
        if (stockCount.length === 0) {
            return interaction.reply({
                content: '❌ No accounts in stock! Use `/addstock` to add accounts.',
                flags: 64
            });
        }

        let stockMessage = '**📊 Current Stock:**\n';
        stockCount.forEach(item => {
            let serviceName = '';
            if (item.service_type === 'nfa') serviceName = 'Minecraft Non Full Access (NFA)';
            else if (item.service_type === 'fa') serviceName = 'Minecraft Full Access (FA)';
            else if (item.service_type === 'xboxgp') serviceName = 'Xbox GamePass';
            
            stockMessage += `• ${serviceName}: ${item.count} accounts\n`;
        });

        await interaction.reply({
            content: stockMessage,
            flags: 64
        });
    } catch (error) {
        console.error('Error in stock command:', error);
        await interaction.reply({
            content: '❌ Database error occurred while checking stock.',
            flags: 64
        });
    }
}

// Gen command
async function handleGen(interaction) {
    try {
        const serviceType = interaction.options.getString('service');
        
        const guildSettings = await getGuildSettings(interaction.guild.id);

        if (!guildSettings) {
            return interaction.reply({
                content: '❌ Please run `/setup` first!',
                flags: 64
            });
        }

        const payoutRole = guildSettings.payout_role;
        if (!interaction.member.roles.cache.has(payoutRole)) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command!',
                flags: 64
            });
        }

        // Get random unused account
        const account = await getRandomAccount(interaction.guild.id, serviceType);

        if (!account) {
            return interaction.reply({
                content: '❌ No accounts available for this service! Please add more stock using `/addstock`',
                flags: 64
            });
        }

        // Create DM message based on service type
        let dmMessage = '';
        const fullAccessLink = 'https://drive.google.com/file/u/0/d/1X1H3vy1UKJPEv5kiBp60LBMCm4AktH29/view?pli=1';

        if (serviceType === 'fa') {
            dmMessage = `here is what you need to payout\n\`\`\`Here Is Your Minecraft Account Full Access :mc:\nEmail: ||${account.email}||\nPassword: ||${account.password}||\nHere Is How To Get Full Access!\n${fullAccessLink}\`\`\``;
        } else if (serviceType === 'nfa') {
            dmMessage = `here is what you need to payout\n\`\`\`Here Is Your Minecraft Account Non Full Access :mc:\nEmail: ||${account.email}||\nPassword: ||${account.password}||\`\`\``;
        } else if (serviceType === 'xboxgp') {
            dmMessage = `here is what you need to payout\n\`\`\`Here Is Your Xbox GamePass account :xbox:\nEmail: ||${account.email}||\nPassword: ||${account.password}||\nHere Is How To Get Full Access!\n${fullAccessLink}\`\`\``;
        }

        try {
            // Send DM to user
            await interaction.user.send(dmMessage);
            
            await interaction.reply({
                content: '✅ Account has been sent to your DMs!',
                flags: 64
            });
        } catch (error) {
            await interaction.reply({
                content: '❌ I cannot send you a DM. Please enable DMs from server members and try again.',
                flags: 64
            });
        }
    } catch (error) {
        console.error('Error in gen command:', error);
        await interaction.reply({
            content: '❌ Database error occurred while generating account.',
            flags: 64
        });
    }
}

// Event handlers
client.on('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    await initializeDatabase();
    await registerCommands();
    console.log('🤖 Bot is ready! Prefix: $');
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'setup') {
                await handleSetup(interaction);
            } else if (interaction.commandName === 'addstock') {
                await handleAddStock(interaction);
            } else if (interaction.commandName === 'gen') {
                await handleGen(interaction);
            } else if (interaction.commandName === 'stock') {
                await handleStock(interaction);
            }
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'payout_role_select') {
                const roleId = interaction.values[0];
                
                await setGuildSettings(interaction.guild.id, roleId);

                await interaction.update({
                    content: `✅ Payout role set to <@&${roleId}> successfully!`,
                    components: []
                });
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'addstock_modal') {
                const email = interaction.fields.getTextInputValue('email_input');
                const password = interaction.fields.getTextInputValue('password_input');
                const serviceType = interaction.fields.getTextInputValue('service_input').toLowerCase();

                // Validate inputs
                if (!['nfa', 'fa', 'xboxgp'].includes(serviceType)) {
                    return interaction.reply({
                        content: '❌ Invalid service type! Use "nfa", "fa", or "xboxgp"',
                        flags: 64
                    });
                }

                try {
                    await addAccount(interaction.guild.id, email, password, serviceType);

                    await interaction.reply({
                        content: `✅ Account added successfully!\nService: ${serviceType.toUpperCase()}`,
                        flags: 64
                    });
                } catch (error) {
                    console.error('Error adding account:', error);
                    await interaction.reply({
                        content: '❌ Error adding account to database',
                        flags: 64
                    });
                }
            }
        }
    } catch (error) {
        console.error('Interaction error:', error);
        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ An error occurred while processing your command.',
                flags: 64
            }).catch(console.error);
        }
    }
});

// Xử lý prefix commands
client.on('messageCreate', async (message) => {
    // Ignore messages from bots and without prefix
    if (message.author.bot || !message.content.startsWith('$')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    // Check if command exists
    if (prefixCommands[commandName]) {
        try {
            await prefixCommands[commandName].execute(message, args);
        } catch (error) {
            console.error('Prefix command error:', error);
            await message.reply('❌ There was an error executing that command.');
        }
    }
});

// Xử lý lỗi kết nối database
pool.on('error', (err) => {
    console.error('❌ PostgreSQL connection error:', err);
});

client.login(process.env.DISCORD_TOKEN);
