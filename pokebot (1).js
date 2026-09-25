// npm install discord.js@14.15.3 @discordjs/rest@2.9.0 discord-api-types@0.38.2 dotenv@16.4.5 node-fetch@3.3.2

// .env.example
// DISCORD_TOKEN=your_bot_token_here
// CLIENT_ID=your_application_id_here
// LOG_CHANNEL_ID=123456789012345678
// SUPPORT_ROLE_ID=123456789012345678
// MIDDLEMAN_ROLE_ID=123456789012345678
// DISPUTE_ROLE_ID=123456789012345678

import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { Client, Collection, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, ChannelType, ForumChannel, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, GuildMember, Role, Message, Attachment, Embed } from 'discord.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
});

client.commands = new Collection();
client.cardLists = new Map(); // lang → { forumId, sets: Map<setId, postId> }
client.marketplaceForums = new Set();
client.auctionForum = null;
client.verifiedTagId = null;
client.liveTagId = null;
client.endedTagId = null;
client.soldTagId = null;
client.availableTagId = null;
client.removedTagId = null;
client.ticketPanels = new Map(); // channelId → { panelId, config }
client.tickets = new Map(); // ticketId → { userId, sellerId, type: 'marketplace'|'auction'|'support', data }
client.auctions = new Map(); // postId → { sellerId, cardName, set, number, language, startPrice, minBid, buyPrice, bids: [], ended: false, winnerId: null }
client.bids = new Map(); // auctionPostId → [{ userId, amount, timestamp }]
client.logChannelId = process.env.LOG_CHANNEL_ID || '';
client.supportRoleId = process.env.SUPPORT_ROLE_ID || '';
client.middlemanRoleId = process.env.MIDDLEMAN_ROLE_ID || '';
client.disputeRoleId = process.env.DISPUTE_ROLE_ID || '';

// Load commands
const commandsPath = path.join(process.cwd(), 'commands');
const commandFiles = await fs.readdir(commandsPath).catch(() => []);
for (const file of commandFiles) {
  if (!file.endsWith('.js')) continue;
  const filePath = path.join(commandsPath, file);
  const command = await import(filePath);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  }
}

// Slash command registration
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ PokeBot logged in as ${client.user.tag}`);
  console.log(`🚀 Ready on ${client.guilds.cache.size} guilds`);

  try {
    const commands = [...client.commands.values()].map(cmd => cmd.data);
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ Registered ${commands.length} application commands`);
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }

  client.user.setActivity({ name: '/cardlist | Pokémon Cards', type: ActivityType.Watching });
});

// Ticket handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit() && !interaction.isSelectMenu()) return;

  // Handle commands
  if (interaction.isCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, client);
    } catch (error) {
      console.error(`❌ Error executing ${interaction.commandName}:`, error);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ An error occurred while processing this command.', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ An error occurred while processing this command.', ephemeral: true });
      }
    }
  }

  // Handle buttons
  if (interaction.isButton()) {
    const customId = interaction.customId;

    // Marketplace buttons
    if (customId.startsWith('buy_now_') || customId.startsWith('negotiate_')) {
      const postId = customId.split('_').slice(2).join('_');
      const post = await client.channels.fetch(postId).catch(() => null);
      if (!post || !post.isThreadInForum()) {
        await interaction.reply({ content: '❌ Invalid marketplace listing.', ephemeral: true });
        return;
      }
      const thread = post;
      const guild = interaction.guild;
      const member = interaction.member;

      // Fetch listing metadata from thread
      const title = thread.name;
      let cardName = '', set = '', number = '', language = '', price = '', photos = [];
      const description = thread?.lastMessage?.content || '';
      // Simplified parsing — real bot would use structured embeds or tags
      // In production, store metadata in thread's availableTags or in DB

      const listingData = {
        title,
        description,
        cardName: title.split('—')[0].trim(),
        set: title.includes('—') ? title.split('—')[1].trim() : 'Unknown',
        number: 'N/A',
        language: 'English',
        price: 'N/A',
        photos: [],
      };

      const buyerId = interaction.user.id;
      const sellerId = thread.ownerId;

      // Create private ticket
      const category = guild.channels.cache.find(c => c.name === 'Tickets' && c.type === ChannelType.GuildCategory);
      const ticketChannel = await guild.channels.create({
        name: `ticket-${Date.now().toString(36)}`,
        type: ChannelType.GuildText,
        parent: category || undefined,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: buyerId,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
          },
          {
            id: sellerId,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
          },
          {
            id: client.user.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
          },
        ],
      });

      const supportRole = guild.roles.cache.get(client.supportRoleId);
      if (supportRole) {
        await ticketChannel.permissionOverwrites.edit(supportRole, {
          ViewChannel: true,
          SendMessages: true,
        });
      }

      const ticketId = ticketChannel.id;
      client.tickets.set(ticketId, {
        userId: buyerId,
        sellerId,
        type: 'marketplace',
        data: listingData,
      });

      const embed = new EmbedBuilder()
        .setTitle('🛒 Marketplace Transaction')
        .setDescription(`**Buyer:** <@${buyerId}>\n**Seller:** <@${sellerId}>\n\n${listingData.title}`)
        .addFields(
          { name: 'Card', value: listingData.cardName || 'N/A', inline: true },
          { name: 'Set', value: listingData.set || 'N/A', inline: true },
          { name: 'Language', value: listingData.language || 'N/A', inline: true }
        )
        .setColor(0x00ff00)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`middleman_${ticketId}`).setLabel('🤝 Middleman').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`dispute_${ticketId}`).setLabel('⚖️ Dispute').setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: `✅ Transaction ticket created: ${ticketChannel}`, ephemeral: true });

      // Log
      if (client.logChannelId) {
        const logChannel = await client.channels.fetch(client.logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          await logChannel.send(`🎫 Ticket opened: ${ticketChannel} for listing <${thread.url()}>`);
        }
      }
      return;
    }

    // Middleman button
    if (customId.startsWith('middleman_')) {
      const ticketId = customId.split('_')[1];
      const ticketChannel = await client.channels.fetch(ticketId).catch(() => null);
      if (!ticketChannel || !ticketChannel.isTextBased()) {
        await interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
        return;
      }

      const middlemanRole = interaction.guild.roles.cache.get(client.middlemanRoleId);
      if (middlemanRole) {
        await ticketChannel.permissionOverwrites.edit(middlemanRole, {
          ViewChannel: true,
          SendMessages: true,
        });
        await ticketChannel.send(`<@&${client.middlemanRoleId}> 🤝 Middleman requested.`);
      }
      await interaction.update({ content: '✅ Middleman team notified.', components: [] });
      return;
    }

    // Dispute button
    if (customId.startsWith('dispute_')) {
      const ticketId = customId.split('_')[1];
      const ticketChannel = await client.channels.fetch(ticketId).catch(() => null);
      if (!ticketChannel || !ticketChannel.isTextBased()) {
        await interaction.reply({ content: '❌ Invalid ticket.', ephemeral: true });
        return;
      }

      const disputeRole = interaction.guild.roles.cache.get(client.disputeRoleId);
      if (disputeRole) {
        await ticketChannel.permissionOverwrites.edit(disputeRole, {
          ViewChannel: true,
          SendMessages: true,
        });
        await ticketChannel.send(`<@&${client.disputeRoleId}> ⚖️ Dispute reported.`);
      }
      await interaction.update({ content: '✅ Dispute team notified.', components: [] });
      return;
    }

    // Auction bid button
    if (customId.startsWith('place_bid_')) {
      const postId = customId.split('_').slice(2).join('_');
      const post = await client.channels.fetch(postId).catch(() => null);
      if (!post || !post.isThreadInForum()) {
        await interaction.reply({ content: '❌ Invalid auction listing.', ephemeral: true });
        return;
      }

      const thread = post;
      const auction = client.auctions.get(postId);
      if (!auction || auction.ended) {
        await interaction.reply({ content: '❌ This auction has ended.', ephemeral: true });
        return;
      }

      // Check Live tag
      const liveTag = thread.appliedTags.find(t => t === client.liveTagId);
      if (!liveTag) {
        await interaction.reply({ content: '❌ This auction is not live.', ephemeral: true });
        return;
      }

      // Open modal
      const modal = new ModalBuilder()
        .setCustomId(`bid_modal_${postId}`)
        .setTitle('Place Your Bid');

      const amountInput = new TextInputBuilder()
        .setCustomId('bid_amount')
        .setLabel('Bid Amount (R)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const firstActionRow = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(firstActionRow);

      await interaction.showModal(modal);
      return;
    }

    // View bids button
    if (customId.startsWith('view_bids_')) {
      const postId = customId.split('_').slice(2).join('_');
      const bids = client.bids.get(postId) || [];
      const auction = client.auctions.get(postId);
      if (!auction) {
        await interaction.reply({ content: '❌ Auction not found.', ephemeral: true });
        return;
      }

      const highestBid = bids.length > 0 ? Math.max(...bids.map(b => b.amount)) : auction.startPrice;
      const embed = new EmbedBuilder()
        .setTitle('🔨 Auction Bids')
        .setDescription(`Current Bid: **R${highestBid}**\nTotal Bids: **${bids.length}**`)
        .setColor(0x00aaff);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  }

  // Handle modals
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('bid_modal_')) {
      const postId = interaction.customId.split('_').slice(2).join('_');
      const amount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
      const auction = client.auctions.get(postId);
      const bids = client.bids.get(postId) || [];

      if (!auction) {
        await interaction.reply({ content: '❌ Auction not found.', ephemeral: true });
        return;
      }

      const currentHighest = bids.length > 0 ? Math.max(...bids.map(b => b.amount)) : auction.startPrice;
      if (amount <= currentHighest) {
        await interaction.reply({ content: `❌ Your bid must be higher than R${currentHighest}.`, ephemeral: true });
        return;
      }
      if (amount < auction.minBid) {
        await interaction.reply({ content: `❌ Minimum bid is R${auction.minBid}.`, ephemeral: true });
        return;
      }

      bids.push({ userId: interaction.user.id, amount, timestamp: Date.now() });
      client.bids.set(postId, bids);

      await interaction.reply({ content: `✅ Bid placed: R${amount}`, ephemeral: true });
      return;
    }
  }
});

// Listen for forum posts
client.on('threadCreate', async thread => {
  if (!thread.parent || !thread.parent.isForumBased()) return;

  const guild = thread.guild;
  const forumId = thread.parentId;

  // Card list set detection
  const cardListLang = [...client.cardLists.entries()].find(([, v]) => v.forumId === forumId);
  if (cardListLang) {
    const lang = cardListLang[0];
    const langData = client.cardLists.get(lang);
    langData.sets.set(thread.id, thread.id); // store postId as key & value for now
    await thread.send(`✅ This is now the **${lang}** set "${thread.name}". Use \`/cardlist\` to browse.`);
    return;
  }

  // Marketplace listing detection
  if (client.marketplaceForums.has(forumId)) {
    // Parse title/description for card info
    const title = thread.name;
    const desc = thread?.lastMessage?.content || '';
    const cardName = title.split('—')[0].trim();
    const set = title.includes('—') ? title.split('—')[1].trim() : 'Unknown';

    // Auto-post marketplace buttons
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`buy_now_${thread.id}`).setLabel('🛒 Buy Now').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`negotiate_${thread.id}`).setLabel('💬 Negotiate').setStyle(ButtonStyle.Primary)
    );

    await thread.send({ components: [row] });
    return;
  }

  // Auction detection
  if (forumId === client.auctionForum) {
    // Only post buttons if Verified tag applied
    const verifiedTag = thread.appliedTags.find(t => t === client.verifiedTagId);
    if (verifiedTag) {
      const liveTag = thread.appliedTags.find(t => t === client.liveTagId);
      const disabled = !liveTag;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`place_bid_${thread.id}`).setLabel('🔨 Place Bid').setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`view_bids_${thread.id}`).setLabel('📋 View Bids').setStyle(ButtonStyle.Secondary)
      );

      await thread.send({ components: [row] });

      // Store auction metadata
      const startPrice = desc.match(/Starting Bid:\s*R(\d+)/)?.[1] || '0';
      const minBid = desc.match(/Minimum Bid:\s*R(\d+)/)?.[1] || '10';
      const buyPrice = desc.match(/Buy Price:\s*R(\d+)/)?.[1] || '0';

      client.auctions.set(thread.id, {
        sellerId: thread.ownerId,
        cardName,
        set,
        number: 'N/A',
        language: 'English',
        startPrice: parseInt(startPrice),
        minBid: parseInt(minBid),
        buyPrice: parseInt(buyPrice),
        bids: [],
        ended: false,
        winnerId: null,
      });

      client.bids.set(thread.id, []);
    }
  }
});

// Welcome message & auto-role
client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const welcomeChannel = guild.systemChannel || (await guild.channels.fetch()).find(ch => ch.name === 'welcome' && ch.isTextBased());
  if (welcomeChannel) {
    const embed = new EmbedBuilder()
      .setTitle('🎉 Welcome to the Pokémon Card Community!')
      .setDescription(`Hello ${member}, welcome to the server!\n\nCheck out <#card-list-english> to browse cards.`)
      .setColor(0x00ff00)
      .setTimestamp();

    await welcomeChannel.send({ embeds: [embed] });
  }

  // Auto-role
  const role = guild.roles.cache.find(r => r.name === 'Member');
  if (role && !member.roles.cache.has(role.id)) {
    try {
      await member.roles.add(role);
    } catch (e) {
      console.warn(`❌ Failed to assign role to ${member.id}:`, e.message);
    }
  }
});

// Leave announcement
client.on('guildMemberRemove', async member => {
  const guild = member.guild;
  const leaveChannel = guild.systemChannel || (await guild.channels.fetch()).find(ch => ch.name === 'welcome' && ch.isTextBased());
  if (leaveChannel) {
    await leaveChannel.send(`👋 ${member.user.tag} has left the server.`);
  }
});

// Message moderation (basic)
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const badWords = ['badword1', 'badword2']; // replace with actual list
  const content = message.content.toLowerCase();
  if (badWords.some(word => content.includes(word))) {
    try {
      await message.delete();
      await message.author.send(`⚠️ Your message contained prohibited language and was removed.`);
    } catch (e) {
      // DM failed; ignore
    }
  }
});

// Error handling
process.on('unhandledRejection', error => {
  console.error('❌ Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', error => {
  console.error('❌ Uncaught Exception:', error);
});

client.login(process.env.DISCORD_TOKEN);