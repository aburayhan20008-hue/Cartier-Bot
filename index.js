const {
  Client, GatewayIntentBits, Partials, Events, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const http = require('http');
const path = require('path');
const fs = require('fs');

// =========================================
// ✅ CONFIG
// =========================================
const SERVER_ID = '812051693357236224';

// Members with ANY of these roles can use every command in this bot.
// Anyone else who tries is treated as an anti-cheat-style violation (see
// the unauthorized-access check in the interaction handler below).
const UPLOAD_ROLE_IDS = [
  '1278457065941106771',
  '1287295276058546199',
  '1161693693703630950',
];

const CHANNELS = {
  rev:       '1187867177894813846',
  citizen:   '1187867137025507419',
  gunpack:   '1187867252675059792',
  clothes:   '1187867333004369930',
  sneakPeek: '1206953235584385034',
};

const WELCOME_CHANNEL_ID = '1151998065918627923';
const PARTNERS_CHANNEL_ID = '1127935952694820864';
// Giveaways and giveaway announcements now share one channel.
const GIVEAWAY_CHANNEL_ID = '1157179464128675911';
const GIVEAWAY_ANNOUNCE_CHANNEL_ID = GIVEAWAY_CHANNEL_ID;

const WELCOME_IMAGE_PATH = path.join(__dirname, 'welcome.gif');
// Cartier Modz wordmark — attached at the end of every upload post, below
// any auto-embedded preview video/link card.
const BRAND_FOOTER_IMAGE_PATH = path.join(__dirname, 'brand-footer.gif');

// ===== ANTI-CHEAT WATCH CONFIG =====
const MOD_LOG_CHANNEL_ID = '1551184154480353351'; // timeout/ban info + remove-timeout/unban buttons
const ALERT_CHANNEL_ID = '1551184245811183626';    // keyword flags + join/leave alerts

// Messages in these channels are NEVER scanned for keywords/bad-servers —
// no flag, no timeout, no ban. Use this for a staff/mod-discussion channel
// where cheat servers get discussed openly without triggering punishment.
const ANTICHEAT_EXEMPT_CHANNEL_IDS = ['1188058619267256401'];

// Case-insensitive substring match against every message in the server.
const FLAG_KEYWORDS = [
  '113 cheats', 'rage cheats', 'rage cheat', 'fivem cheats', 'fivem cheat',
  'hardware cheats', 'hardware cheat', 'dma cheats', 'dma cheat',
  'dms cheats', 'dms cheat', 'triggerbot', 'trigger bot', 'aimbot',
  'wallhack', 'esp cheat', 'cheat discord', 'cheats discord',
  'cheat server', 'cheat website', 'cheat seller',
  // Short standalone words — these are broader on purpose (no "cheat X"
  // phrase needed), so a bare "cheat" or "hack" now matches too.
  'cheat', 'cheats', 'cheater', 'cheating',
  'hack', 'hacks', 'hacker', 'hacking',
  'spoofer', 'bypass', 'crack', 'cracked', 'keygen',
];

const UPLOADER_TAG = '𝑪𝒂𝒓𝒕𝒊𝒆𝒓 𝑴𝒐𝒅𝒛'; // shown instead of the real uploader's name

// Brand accent used across every embed/container in this bot.
const BRAND_RED = 0x8B0000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User],
});

function isStaff(member) {
  return !!member && member.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id));
}

// =========================================
// ✅ ANTI-CHEAT DATA (bad-server list + violation counts)
// =========================================
// Persisted to a JSON file so the bad-server list and strike counts survive
// a restart. On Railway, put this on a Volume (see setup notes) or it
// resets whenever the container redeploys — same caveat as any bot without
// a database.
const DATA_DIR = process.env.DATA_DIR || '.';
const DATA_FILE = path.join(DATA_DIR, 'anticheat.json');

function loadAntiCheatDB() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { badServers: {}, violations: {}, giveaways: {}, ...loaded };
  } catch {
    return { badServers: {}, violations: {}, giveaways: {} };
  }
}
function saveAntiCheatDB() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(acDB, null, 2));
  } catch (err) {
    console.error('❌ Failed to save anti-cheat DB:', err);
  }
}
let acDB = loadAntiCheatDB();

function findMatchedKeyword(text) {
  const lower = text.toLowerCase();
  return FLAG_KEYWORDS.find(kw => lower.includes(kw));
}

function findMatchedBadServer(text) {
  const lower = text.toLowerCase();
  for (const [identifier, info] of Object.entries(acDB.badServers)) {
    if (lower.includes(identifier)) return { identifier, ...info };
  }
  return null;
}

function recordViolation(userId) {
  acDB.violations[userId] = (acDB.violations[userId] || 0) + 1;
  saveAntiCheatDB();
  return acDB.violations[userId];
}

// =========================================
// ✅ SLASH COMMANDS
// =========================================
function buildUploadCommand(name, description, requireDetails = true) {
  const cmd = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption(o => o.setName('name').setDescription('Mod name').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Download link').setRequired(requireDetails))
    .addStringOption(o => o.setName('password').setDescription('Password / password link').setRequired(requireDetails))
    .addStringOption(o => o.setName('filepath').setDescription('File path (optional)').setRequired(false))
    .addStringOption(o => o.setName('preview').setDescription('Preview link (optional) — auto-embeds a video card').setRequired(false));

  // Up to 5 screenshots, all optional.
  for (let i = 1; i <= 5; i++) {
    cmd.addAttachmentOption(o => o.setName(`screenshot${i}`).setDescription(`Preview screenshot/image ${i} (optional)`).setRequired(false));
  }
  return cmd;
}

const partnersCommand = new SlashCommandBuilder()
  .setName('partners')
  .setDescription('Post a partner ad — pastes your text exactly as-is (invite links auto-embed)')
  .addStringOption(o => o.setName('text').setDescription('The exact text to post').setRequired(true).setMaxLength(2000));

const giveawayCommand = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Start a giveaway in the giveaway channel')
  .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('How many minutes until it ends').setRequired(true).setMinValue(1))
  .addIntegerOption(o => o.setName('winners').setDescription('How many winners (default 1)').setRequired(false).setMinValue(1).setMaxValue(25));

const giveawayAnnounceCommand = new SlashCommandBuilder()
  .setName('giveawayannounce')
  .setDescription('Post a giveaway announcement — pastes your text exactly as-is')
  .addStringOption(o => o.setName('text').setDescription('The exact text to post').setRequired(true).setMaxLength(2000));

const addBadServerCommand = new SlashCommandBuilder()
  .setName('addbadserver')
  .setDescription('Add a banned server to the anti-cheat watch list')
  .addStringOption(o => o.setName('identifier').setDescription('Invite code (e.g. abc123) or a name/word to match').setRequired(true))
  .addStringOption(o => o.setName('label').setDescription('Display name shown in logs').setRequired(true));

const removeBadServerCommand = new SlashCommandBuilder()
  .setName('removebadserver')
  .setDescription('Remove a server from the anti-cheat watch list')
  .addStringOption(o => o.setName('identifier').setDescription('The exact identifier you added it with').setRequired(true));

const listBadServersCommand = new SlashCommandBuilder()
  .setName('listbadservers')
  .setDescription('List every server currently on the anti-cheat watch list');

const fixPermsCommand = new SlashCommandBuilder()
  .setName('fixperms')
  .setDescription('[Staff] Clear all channel-specific permission overrides for this bot, everywhere in the server');

const deleteMessageCommand = new SlashCommandBuilder()
  .setName('deletemessage')
  .setDescription('[Staff] Delete a member\'s messages across the whole server, within a time window')
  .addUserOption(o => o.setName('user').setDescription('Whose messages to delete').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('How far back to search, in minutes (e.g. 60 = last hour)').setRequired(true).setMinValue(1));

const giveawayRerollCommand = new SlashCommandBuilder()
  .setName('giveawayreroll')
  .setDescription('[Staff] Pick a replacement winner (e.g. when a winner left the server)')
  .addStringOption(o => o.setName('giveaway').setDescription('Which ended giveaway').setRequired(true).setAutocomplete(true))
  .addUserOption(o => o.setName('replace').setDescription('Winner to replace — leave empty to replace every winner who left the server').setRequired(false));

const commands = [
  buildUploadCommand('revupload', 'Post a new REV mod'),
  buildUploadCommand('citizenupload', 'Post a new Citizen mod'),
  buildUploadCommand('gunpackupload', 'Post a new Gunpack mod'),
  buildUploadCommand('clothesupload', 'Post a new Clothes mod'),
  buildUploadCommand('sneakpeekupload', 'Post a new Sneak Peek', false),
  partnersCommand,
  giveawayCommand,
  giveawayAnnounceCommand,
  giveawayRerollCommand,
  addBadServerCommand,
  removeBadServerCommand,
  listBadServersCommand,
  fixPermsCommand,
  deleteMessageCommand,
].map(c => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, SERVER_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }

  rehydrateGiveaways();
  backfillRerollButtons().catch(err => console.error('❌ Reroll button backfill failed:', err));
});

// =========================================
// ✅ MESSAGE BUILDER
// =========================================
// Plain message content (not an embed) — this is what makes the big "#"
// heading, bold labels, and masked [text](url) links render at FULL size,
// exactly like the manual human posts. Embeds compress everything into a
// smaller box; plain content does not.
const GAP = '\u200b'; // zero-width space — Discord collapses truly-empty lines right after a "# heading", but not lines with invisible content like this.

function buildUploadContent({ name, link, password, preview, filepath }) {
  const lines = [
    `# ${name}`,
    GAP, GAP,
  ];

  if (filepath) {
    lines.push(`**File Path:** ${filepath}`, '', '');
  }

  if (link) {
    lines.push(`**Link:** [Download](${link})`, '', '');
  }

  if (password) {
    lines.push(`**Password:** ${password}`);
  }

  // A URL on its own line makes Discord auto-generate a real video preview
  // card underneath — the "Preview:" label doesn't break that, Discord still
  // detects and embeds the URL wherever it appears in the line.
  if (preview) {
    lines.push('', '', `**Preview:** ${preview}`);
  }

  return lines.join('\n');
}

// =========================================
// ✅ WELCOME MESSAGE (new member joins)
// =========================================
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== SERVER_ID) return;

  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
    const welcomeImage = new AttachmentBuilder(WELCOME_IMAGE_PATH, { name: 'welcome.gif' });

    const container = new ContainerBuilder()
      .setAccentColor(BRAND_RED)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`〽️ Welcome ${member} to Cartier Modz ❤️`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# Cartier Modz 🧸'),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '〽️ Welcome to Cartier Modz ❤️, ' + `${member}` + '!\n' +
          '✨You’re now part of something legendary.✨\n' +
          '🎗️ Get ready for epic vibes, dope chats, and a community that has your back.🎖️\n' +
          '♣️  Check out the channels, meet the crew, and most importantly… Have fun! 🍹'
        ),
      )
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL('attachment://welcome.gif'),
        ),
      );

    await channel.send({
      components: [container],
      files: [welcomeImage],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('❌ Welcome message failed:', err);
  }

  // Anti-cheat watch — join alert
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content: `📥 **Joined:** ${member} (\`${member.user.tag}\`, \`${member.id}\`) — <t:${Math.floor(Date.now() / 1000)}:F>`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Join alert failed:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id !== SERVER_ID) return;
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content: `📤 **Left:** \`${member.user?.tag || member.id}\` (\`${member.id}\`) — <t:${Math.floor(Date.now() / 1000)}:F>`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Leave alert failed:', err);
  }
});

// =========================================
// ✅ ANTI-CHEAT WATCH — punishment + logging
// =========================================
function buildModLogContainer({ userId, userTag, strike, actionLabel, reason, matchedText, sourceChannelId, messageUrl }) {
  const accentColor = strike >= 3 ? 0xE74C3C : strike === 2 ? 0xE67E22 : 0xF1C40F;
  const lines = [
    `**User:** <@${userId}> (\`${userTag}\`, \`${userId}\`)`,
    '',
    `**Strike:** ${strike}`,
    '',
    `**Action:** ${actionLabel}`,
    '',
    `**Reason:** ${reason}`,
    '',
    `**Matched Text:** \`${matchedText}\``,
    '',
    `**Channel:** <#${sourceChannelId}>${messageUrl ? ` • [Jump to message](${messageUrl})` : ''}`,
    '',
    `-# <t:${Math.floor(Date.now() / 1000)}:F>`,
  ];

  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(strike >= 3 ? '# 🔨 Ban Issued' : '# ⏱️ Timeout Issued'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

// Received messages expose resolved Component classes — a Container's own
// scalar fields (type, accent_color) live on `.data`, but its CHILDREN live
// directly on `.components`. This reads both correctly.
function rawComponentData(component) {
  return component?.data ?? component;
}
function childrenOfComponent(component) {
  return component?.components ?? component?.data?.components ?? [];
}

// Appends a "**Resolved:** ..." line to the mod-log message's detail block
// (keeping the title and every original line intact) and drops the button
// row, since the request is now handled.
function rebuildModLogResolved(message, resolvedLine) {
  const children = childrenOfComponent(message.components?.[0]);
  const originalAccent = rawComponentData(message.components?.[0])?.accent_color;
  const newContainer = new ContainerBuilder().setAccentColor(originalAccent ?? 0x2ECC71);

  children.forEach((child, idx) => {
    const c = rawComponentData(child);
    if (c?.type !== 10) return; // Text Display only — this container has no separators/buttons inside it
    const isLastLine = idx === children.length - 1;
    const content = isLastLine ? `${c.content}\n\n${resolvedLine}` : c.content;
    newContainer.addTextDisplayComponents(td => td.setContent(content));
  });

  return newContainer;
}

function buildModLogButtonRow(userId, wasBan) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(wasBan ? `modlog_unban_${userId}` : `modlog_removetimeout_${userId}`)
      .setLabel(wasBan ? '🔓 Unban' : '⏱️ Remove Timeout')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function applyPunishment(member, strike, reason, matchedText, sourceChannelId, messageUrl) {
  let actionLabel;
  let wasBan = false;
  let actionSucceeded = true;

  try {
    if (strike === 1) {
      actionLabel = 'Timeout — 5 minutes';
      await member.timeout(5 * 60 * 1000, reason);
    } else if (strike === 2) {
      actionLabel = 'Timeout — 10 minutes';
      await member.timeout(10 * 60 * 1000, reason);
    } else {
      actionLabel = 'Ban';
      wasBan = true;
      await member.ban({ reason });
    }
  } catch (err) {
    console.error('❌ Punishment action failed:', err);
    actionLabel = `${actionLabel || 'Action'} (⚠️ FAILED — check bot permissions/role position)`;
    actionSucceeded = false;
  }

  // DM them why — only if the action actually went through (no point
  // telling someone "you've been banned" when the ban itself failed).
  if (actionSucceeded) {
    let dmText;
    if (strike === 1) {
      dmText =
        `⏱️ **You've been timed out for 5 minutes.**\n\n` +
        `**Reason:** ${reason}\n` +
        `**Text:** ${matchedText}\n\n` +
        `⚠️ If this happens again, you'll be timed out a 2nd time (10 minutes). A 3rd violation gets you **banned** from the server.`;
    } else if (strike === 2) {
      dmText =
        `⏱️ **You've been timed out for 10 minutes (2nd violation).**\n\n` +
        `**Reason:** ${reason}\n` +
        `**Text:** ${matchedText}\n\n` +
        `⚠️ This is your final warning — one more violation will get you **permanently banned** from the server.`;
    } else {
      dmText =
        `🔨 **You've been banned from the server.**\n\n` +
        `**Reason:** ${reason}\n` +
        `**Text:** ${matchedText}\n\n` +
        `This was your 3rd violation of the anti-cheat policy.`;
    }
    await member.send(dmText).catch(() => {}); // ignore — DMs closed is common and not worth logging
  }

  try {
    const logChannel = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
    await logChannel.send({
      components: [
        buildModLogContainer({
          userId: member.id,
          userTag: member.user.tag,
          strike,
          actionLabel,
          reason,
          matchedText,
          sourceChannelId,
          messageUrl,
        }),
        buildModLogButtonRow(member.id, wasBan),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    console.error('❌ Mod log post failed:', err);
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.guild?.id !== SERVER_ID) return;
  if (message.author.bot) return;
  if (!message.content) return;
  if (ANTICHEAT_EXEMPT_CHANNEL_IDS.includes(message.channel.id)) return;

  const keywordMatch = findMatchedKeyword(message.content);
  const badServerMatch = findMatchedBadServer(message.content);
  if (!keywordMatch && !badServerMatch) return;

  const matchedText = keywordMatch || badServerMatch.identifier;
  const reason = keywordMatch
    ? `Suspicious keyword: "${keywordMatch}"`
    : `Reference to banned server: "${badServerMatch.label}"`;

  // Delete the flagged message immediately — from ANY text channel,
  // including the text-in-voice chat of a voice channel (same message
  // type/permissions as a regular channel, so this works there too).
  // Regular members never see it; staff can still read the full text
  // below, in the alert log.
  await message.delete().catch(err => {
    console.error('❌ Could not delete flagged message (check the bot\'s Manage Messages permission in that channel):', err.message);
  });

  // Alert first, regardless of whether the punishment step succeeds.
  try {
    const alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
    await alertChannel.send({
      content:
        `🚩 **Flagged Message (deleted)**\n` +
        `**User:** ${message.author} (\`${message.author.tag}\`, \`${message.author.id}\`)\n` +
        `**Channel:** <#${message.channel.id}>\n` +
        `**Matched:** \`${matchedText}\`\n` +
        `**Message:** ${message.content.slice(0, 1000)}`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error('❌ Flag alert post failed:', err);
  }

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  // Staff/access roles are exempt from auto-punishment — the message is
  // still deleted and logged above, they just don't get timed out or banned.
  if (member.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) return;

  const strike = recordViolation(message.author.id);
  await applyPunishment(member, strike, reason, matchedText, message.channel.id, null);
});

// =========================================
// ✅ GIVEAWAY SYSTEM
// =========================================
// In-memory only — a giveaway still running when the bot restarts will be
// lost (no database in this bot). Fine for short/medium giveaways.
const giveaways = new Map(); // giveawayId -> { prize, endsAt, winnersCount, participants: Set<userId>, channelId, messageId, ended, hostId, winners }
const giveawayTimers = new Map();

// Giveaways survive a restart via the same JSON file as the anti-cheat data.
// participants is a Set at runtime (fast lookups) but stored as an array.
function persistGiveaway(giveawayId) {
  const g = giveaways.get(giveawayId);
  if (!g) return;
  acDB.giveaways[giveawayId] = { ...g, participants: [...g.participants] };
  saveAntiCheatDB();
}

// Runs once on startup — restores any giveaway that was still running when
// the bot last stopped, and picks up exactly where it left off. One still
// ended while the bot was offline gets its winners drawn immediately.
function rehydrateGiveaways() {
  for (const [giveawayId, saved] of Object.entries(acDB.giveaways || {})) {
    // Ended giveaways are loaded too (just not re-scheduled) so /giveawayreroll
    // and "View Entries" keep working after a restart.
    giveaways.set(giveawayId, { ...saved, participants: new Set(saved.participants) });
    if (saved.ended) continue;

    const remaining = saved.endsAt - Date.now();
    if (remaining <= 0) {
      endGiveaway(giveawayId).catch(err => console.error('❌ Giveaway catch-up end failed:', err));
    } else {
      scheduleGiveawayEnd(giveawayId, remaining);
    }
  }
}

// One-time upgrade: giveaways that ended BEFORE the Reroll button existed get
// their message edited so the button shows up. `rerollButton` is saved per
// giveaway so this never repeats on later restarts. A deleted message/channel
// is marked done too, so it isn't retried forever.
async function backfillRerollButtons() {
  for (const [giveawayId, g] of giveaways) {
    if (!g.ended || g.rerollButton || !g.messageId) continue;
    try {
      const channel = await client.channels.fetch(g.channelId);
      const msg = await channel.messages.fetch(g.messageId);
      await msg.edit({
        components: [buildGiveawayContainer(g), buildGiveawayButtonRow(giveawayId, true)],
        flags: MessageFlags.IsComponentsV2,
      });
      g.rerollButton = true;
      persistGiveaway(giveawayId);
    } catch (err) {
      console.error(`❌ Could not add Reroll button to giveaway ${giveawayId}:`, err.message);
      if (err.code === 10008 || err.code === 10003) { // Unknown Message / Unknown Channel
        g.rerollButton = true;
        persistGiveaway(giveawayId);
      }
    }
    await new Promise(r => setTimeout(r, 1000)); // stay well under edit rate limits
  }
}

// Stops a double-click on Reroll from running two rerolls at once.
const rerollLocks = new Set();

function buildGiveawayContainer(giveaway) {
  const entryCount = giveaway.participants.size;
  const endsUnix = Math.floor(giveaway.endsAt / 1000);

  const lines = giveaway.ended
    ? [
        `**Prize:** ${giveaway.prize}`,
        '',
        `**Ended:** <t:${endsUnix}:R>`,
        '',
        giveaway.winners.length
          ? `**Winner${giveaway.winners.length > 1 ? 's' : ''}:** ${giveaway.winners.map(id => `<@${id}>`).join(', ')}`
          : '**Winners:** No one entered 😢',
      ]
    : [
        `**Prize:** ${giveaway.prize}`,
        '',
        `**Winners:** ${giveaway.winnersCount}`,
        '',
        `**Ends:** <t:${endsUnix}:R> (<t:${endsUnix}:F>)`,
        '',
        `**Entries:** ${entryCount}`,
      ];

  return new ContainerBuilder()
    .setAccentColor(giveaway.ended ? 0x99AAB5 : 0xF1C40F)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('@everyone'),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(giveaway.ended ? '# 🎉 GIVEAWAY ENDED 🎉' : '# 🎉 GIVEAWAY 🎉'),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n')),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        giveaway.ended
          ? `-# Hosted by <@${giveaway.hostId}>`
          : `-# Click the button below to enter! • Hosted by <@${giveaway.hostId}>`,
      ),
    );
}

function buildGiveawayButtonRow(giveawayId, ended) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter_${giveawayId}`)
      .setLabel(ended ? 'Giveaway Ended' : '🎉 Enter Giveaway')
      .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(ended),
    new ButtonBuilder()
      .setCustomId(`giveaway_entries_${giveawayId}`)
      .setLabel('👥 View Entries')
      .setStyle(ButtonStyle.Secondary),
  );
  // Staff-only (checked on click) — appears only after the giveaway ends.
  if (ended) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_reroll_${giveawayId}`)
        .setLabel('🔁 Reroll')
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

function scheduleGiveawayEnd(giveawayId, delayMs) {
  if (giveawayTimers.has(giveawayId)) clearTimeout(giveawayTimers.get(giveawayId));
  const timer = setTimeout(() => endGiveaway(giveawayId).catch(err => console.error('❌ Giveaway end failed:', err)), delayMs);
  giveawayTimers.set(giveawayId, timer);
}

// True unless Discord says that user is no longer in the server. Any other
// error (rate limit, network blip) counts as "still here" so a hiccup never
// wrongly drops a valid entrant.
async function isInGuild(guild, userId) {
  if (!guild) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (err) {
    return !(err.code === 10007 || err.code === 10013); // Unknown Member / Unknown User
  }
}

// Random picks from the pool, skipping anyone who has left the server.
async function drawFromPool(guild, pool, count) {
  const remaining = [...pool];
  const picked = [];
  while (picked.length < count && remaining.length > 0) {
    const idx = Math.floor(Math.random() * remaining.length);
    const id = remaining.splice(idx, 1)[0];
    if (await isInGuild(guild, id)) picked.push(id);
  }
  return picked;
}

async function endGiveaway(giveawayId) {
  const giveaway = giveaways.get(giveawayId);
  if (!giveaway || giveaway.ended || giveaway.ending) return;
  giveaway.ending = true; // the member checks below are async — block a second concurrent call

  // Only people still in the server can win.
  const guild = await client.guilds.fetch(SERVER_ID).catch(() => null);
  const winners = await drawFromPool(guild, [...giveaway.participants], giveaway.winnersCount);
  delete giveaway.ending;

  giveaway.ended = true;
  giveaway.winners = winners;
  giveaway.rerollButton = true; // the ended message below is posted with the Reroll button
  persistGiveaway(giveawayId);
  if (giveawayTimers.has(giveawayId)) { clearTimeout(giveawayTimers.get(giveawayId)); giveawayTimers.delete(giveawayId); }

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const msg = await channel.messages.fetch(giveaway.messageId);
    await msg.edit({
      components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, true)],
      flags: MessageFlags.IsComponentsV2,
    });

    if (winners.length) {
      await channel.send({
        content: `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! **You are the winner${winners.length > 1 ? 's' : ''}** of **${giveaway.prize}**!`,
        allowedMentions: { users: winners },
      });
    } else {
      await channel.send({ content: `😢 No one entered the giveaway for **${giveaway.prize}** — no winner this time.` });
    }
  } catch (err) {
    console.error('❌ Giveaway end message failed:', err);
  }
}

// Replaces winner(s) of an ENDED giveaway with new random entrants who are
// still in the server. replaceUserId = a specific winner to swap out; if
// omitted, every winner who has left the server is swapped out. Anyone
// already replaced earlier, and anyone currently a winner, is never re-picked.
async function rerollGiveaway(giveawayId, replaceUserId) {
  const giveaway = giveaways.get(giveawayId);
  if (!giveaway) return { error: 'That giveaway no longer exists.' };
  if (!giveaway.ended) return { error: 'That giveaway is still running — reroll only works after it ends.' };
  if (!giveaway.winners.length) return { error: 'That giveaway had no winners to replace.' };

  const guild = await client.guilds.fetch(SERVER_ID).catch(() => null);

  let toReplace;
  if (replaceUserId) {
    if (!giveaway.winners.includes(replaceUserId)) {
      return { error: `<@${replaceUserId}> isn't one of this giveaway's winners.` };
    }
    toReplace = [replaceUserId];
  } else {
    toReplace = [];
    for (const id of giveaway.winners) {
      if (!(await isInGuild(guild, id))) toReplace.push(id);
    }
    if (!toReplace.length) {
      return { error: 'Every winner is still in the server, so nobody was replaced. Use the `replace` option to swap a specific winner anyway.' };
    }
  }

  const blocked = new Set([...(giveaway.excluded || []), ...giveaway.winners]);
  const pool = [...giveaway.participants].filter(id => !blocked.has(id));
  const newWinners = await drawFromPool(guild, pool, toReplace.length);

  if (!newWinners.length) {
    return { error: 'No eligible entrants left to pick from — everyone else already won, was replaced, or has left the server.' };
  }

  // Pair each replaced winner with a new one, in order. If there are fewer
  // eligible entrants than winners to replace, the rest simply stay as-is.
  const pairs = toReplace.slice(0, newWinners.length).map((oldId, i) => ({ oldId, newId: newWinners[i] }));
  const notReplaced = toReplace.slice(newWinners.length);

  giveaway.winners = giveaway.winners.map(id => pairs.find(p => p.oldId === id)?.newId ?? id);
  giveaway.excluded = [...new Set([...(giveaway.excluded || []), ...pairs.map(p => p.oldId)])];
  persistGiveaway(giveawayId);

  try {
    const channel = await client.channels.fetch(giveaway.channelId);

    // Refresh the original giveaway message so it shows the updated winners.
    const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, true)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    const newIds = pairs.map(p => p.newId);
    await channel.send({
      content:
        `🔁 **Giveaway reroll** — **${giveaway.prize}**\n` +
        pairs.map(p => `<@${p.oldId}> → <@${p.newId}>`).join('\n') + '\n\n' +
        `🎉 Congratulations ${newIds.map(id => `<@${id}>`).join(', ')}! **You are the new winner${newIds.length > 1 ? 's' : ''}** of **${giveaway.prize}**!`,
      allowedMentions: { users: newIds },
    });
  } catch (err) {
    console.error('❌ Giveaway reroll announcement failed:', err);
  }

  return { ok: true, pairs, notReplaced };
}

// =========================================
// ✅ COMMAND HANDLER
// =========================================
const COMMAND_CHANNEL_MAP = {
  revupload: CHANNELS.rev,
  citizenupload: CHANNELS.citizen,
  gunpackupload: CHANNELS.gunpack,
  clothesupload: CHANNELS.clothes,
  sneakpeekupload: CHANNELS.sneakPeek,
};

client.on(Events.InteractionCreate, async (interaction) => {
 try {
  // --- /giveawayreroll autocomplete — lists ENDED giveaways, newest first ---
  if (interaction.isAutocomplete() && interaction.commandName === 'giveawayreroll') {
    if (!isStaff(interaction.member)) return interaction.respond([]);
    const typed = interaction.options.getFocused().toLowerCase();
    const choices = [...giveaways.entries()]
      .filter(([, g]) => g.ended && g.prize.toLowerCase().includes(typed))
      .sort((a, b) => b[1].endsAt - a[1].endsAt)
      .slice(0, 25)
      .map(([id, g]) => ({
        name: `${g.prize.slice(0, 70)} (${new Date(g.endsAt).toISOString().slice(0, 10)})`,
        value: id,
      }));
    return interaction.respond(choices);
  }

  // --- Giveaway "Enter" button — open to everyone, no role check ---
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_enter_')) {
    const giveawayId = interaction.customId.replace('giveaway_enter_', '');
    const giveaway = giveaways.get(giveawayId);
    if (!giveaway) return interaction.reply({ content: '⚠️ This giveaway no longer exists.', ephemeral: true });
    if (giveaway.ended) return interaction.reply({ content: '⚠️ This giveaway has already ended.', ephemeral: true });

    if (giveaway.participants.has(interaction.user.id)) {
      return interaction.reply({ content: '✅ You\'re already entered!', ephemeral: true });
    }
    giveaway.participants.add(interaction.user.id);
    persistGiveaway(giveawayId);

    await interaction.update({
      components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, false)],
      flags: MessageFlags.IsComponentsV2,
    });
    return interaction.followUp({ content: '🎉 You\'re entered! Good luck!', ephemeral: true });
  }

  // --- Giveaway "Reroll" button — staff only ---
  // Same logic as /giveawayreroll with `replace` left empty: swaps out every
  // winner who has left the server. For a specific winner use the command.
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_reroll_')) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ Only staff can reroll a giveaway.', ephemeral: true });
    }
    const giveawayId = interaction.customId.replace('giveaway_reroll_', '');
    if (rerollLocks.has(giveawayId)) {
      return interaction.reply({ content: '⏳ A reroll for this giveaway is already running.', ephemeral: true });
    }
    rerollLocks.add(giveawayId);
    try {
      await interaction.deferReply({ ephemeral: true });
      const result = await rerollGiveaway(giveawayId);

      if (result.error) {
        const msg = result.error.replace('Use the `replace` option to swap', 'Use `/giveawayreroll` with the `replace` option to swap');
        return interaction.editReply({ content: `⚠️ ${msg}` });
      }

      let reply = `✅ Reroll done — ${result.pairs.map(p => `<@${p.oldId}> → <@${p.newId}>`).join(', ')}`;
      if (result.notReplaced.length) {
        reply += `\n\n⚠️ Not enough eligible entrants to replace: ${result.notReplaced.map(id => `<@${id}>`).join(', ')} (kept as winner).`;
      }
      return interaction.editReply({ content: reply });
    } finally {
      rerollLocks.delete(giveawayId);
    }
  }

  // --- Giveaway "View Entries" button — only members with a bot-use role ---
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_entries_')) {
    const giveawayId = interaction.customId.replace('giveaway_entries_', '');
    const giveaway = giveaways.get(giveawayId);
    if (!giveaway) return interaction.reply({ content: '⚠️ This giveaway no longer exists.', ephemeral: true });

    if (!interaction.member?.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) {
      return interaction.reply({ content: '❌ You don\'t have permission to view entries.', ephemeral: true });
    }

    const entrants = [...giveaway.participants];
    let list = entrants.length
      ? entrants.map((id, i) => `${i + 1}. <@${id}>`).join('\n')
      : 'No one has entered yet.';

    // Guard against Discord's 2000-char message limit for very large giveaways.
    if (list.length > 1800) {
      const truncated = [];
      let len = 0;
      for (const line of list.split('\n')) {
        if (len + line.length > 1700) break;
        truncated.push(line);
        len += line.length + 1;
      }
      list = truncated.join('\n') + `\n… and ${entrants.length - truncated.length} more`;
    }

    return interaction.reply({
      content: `👥 **Entries for "${giveaway.prize}"** (${entrants.length} total)\n\n${list}`,
      ephemeral: true,
    });
  }

  // --- Mod log "Remove Timeout" / "Unban" buttons — staff only ---
  // Opens a small modal asking for an (optional) reason, instead of acting
  // instantly — the reason then shows up on the mod-log message itself.
  if (interaction.isButton() && (interaction.customId.startsWith('modlog_removetimeout_') || interaction.customId.startsWith('modlog_unban_'))) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ Only staff can do this.', ephemeral: true });
    }

    const isUnban = interaction.customId.startsWith('modlog_unban_');
    const userId = interaction.customId.replace(isUnban ? 'modlog_unban_' : 'modlog_removetimeout_', '');

    const modal = new ModalBuilder()
      .setCustomId(`${isUnban ? 'modlog_unban_modal' : 'modlog_removetimeout_modal'}_${userId}`)
      .setTitle(isUnban ? 'Unban Member' : 'Remove Timeout');

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    return interaction.showModal(modal);
  }

  // --- Modal submit for the two buttons above ---
  if (interaction.isModalSubmit() && (interaction.customId.startsWith('modlog_unban_modal_') || interaction.customId.startsWith('modlog_removetimeout_modal_'))) {
    const isUnban = interaction.customId.startsWith('modlog_unban_modal_');
    const userId = interaction.customId.replace(isUnban ? 'modlog_unban_modal_' : 'modlog_removetimeout_modal_', '');
    const reason = interaction.fields.getTextInputValue('reason').trim() || 'No reason given';

    // Same fix as the upload commands: defer BEFORE the slow guild/member
    // API calls, so a slightly slow unban/fetch can never expire the
    // interaction token and throw "Unknown interaction".
    await interaction.deferReply({ ephemeral: true });

    const guild = await client.guilds.fetch(SERVER_ID);
    let resolvedLine;

    if (isUnban) {
      await guild.members.unban(userId, `Unbanned by ${interaction.user.tag}: ${reason}`).catch(err => {
        console.error('❌ Unban failed:', err);
      });
      resolvedLine = `**Resolved:** 🔓 Unbanned by ${interaction.user} — Reason: ${reason}`;
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.timeout(null, `Timeout removed by ${interaction.user.tag}: ${reason}`).catch(err => {
          console.error('❌ Remove timeout failed:', err);
        });
      }
      resolvedLine = `**Resolved:** ⏱️ Timeout removed by ${interaction.user} — Reason: ${reason}`;
    }

    // Update the mod-log message itself so everyone can see who resolved it
    // (not just an ephemeral reply visible only to the clicker), and drop
    // the button row since this request is now handled.
    if (interaction.message) {
      const newContainer = rebuildModLogResolved(interaction.message, resolvedLine);
      await interaction.message.edit({ components: [newContainer], flags: MessageFlags.IsComponentsV2 }).catch(err => {
        console.error('❌ Could not update mod-log message:', err);
      });
    }

    return interaction.editReply({ content: `✅ Done — ${isUnban ? 'unbanned' : 'timeout removed for'} <@${userId}>.` });
  }

  if (!interaction.isChatInputCommand()) return;

  const isUploadCommand = !!COMMAND_CHANNEL_MAP[interaction.commandName];
  const isPartnersCommand = interaction.commandName === 'partners';
  const isGiveawayCommand = interaction.commandName === 'giveaway';
  const isGiveawayAnnounceCommand = interaction.commandName === 'giveawayannounce';
  const isGiveawayRerollCommand = interaction.commandName === 'giveawayreroll';
  const isAddBadServerCommand = interaction.commandName === 'addbadserver';
  const isRemoveBadServerCommand = interaction.commandName === 'removebadserver';
  const isListBadServersCommand = interaction.commandName === 'listbadservers';
  const isFixPermsCommand = interaction.commandName === 'fixperms';
  const isDeleteMessageCommand = interaction.commandName === 'deletemessage';
  if (!isUploadCommand && !isPartnersCommand && !isGiveawayCommand && !isGiveawayAnnounceCommand && !isGiveawayRerollCommand
      && !isAddBadServerCommand && !isRemoveBadServerCommand && !isListBadServersCommand
      && !isFixPermsCommand && !isDeleteMessageCommand) return;

  try {
    // Role check FIRST, and reply immediately — no awaits before this so we
    // never hit the 3-second "application did not respond" timeout.
    // Trying a restricted command with no permission just gets told no —
    // punishment (timeout/ban) is reserved for the anti-cheat keyword /
    // bad-server watch below, not for command misuse.
    if (!interaction.member?.roles.cache.some(r => UPLOAD_ROLE_IDS.includes(r.id))) {
      return interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    }

    // Acknowledge INSTANTLY (within Discord's 3-second window), before any
    // of the slower work below (channel.fetch, re-uploading screenshots,
    // sending the giveaway message, etc). Without this, a slow step could
    // blow past 3 seconds, the interaction token expires, and the final
    // interaction.reply() then fails with "Unknown interaction" (10062) —
    // which is exactly what was happening on /sneakpeekupload with a
    // screenshot attached. Every reply below is now editReply() instead.
    await interaction.deferReply({ ephemeral: true });

    if (isPartnersCommand) {
      const text = interaction.options.getString('text');
      // Posts the text exactly as typed, as plain content (no embed box) — if
      // it contains a discord.gg invite link, Discord auto-renders the full
      // rich invite card (icon, member count, Join button) on its own.
      // @everyone is tagged automatically so the post actually pings.
      const partnersChannel = await client.channels.fetch(PARTNERS_CHANNEL_ID);
      await partnersChannel.send({
        content: `@everyone\n${text}`,
        allowedMentions: { parse: ['everyone'] },
      });
      return interaction.editReply({ content: '✅ Posted!' });
    }

    if (isGiveawayAnnounceCommand) {
      const text = interaction.options.getString('text');
      // Same idea as /partners — pastes the text exactly as typed, as plain
      // content, with @everyone tagged automatically.
      const announceChannel = await client.channels.fetch(GIVEAWAY_ANNOUNCE_CHANNEL_ID);
      await announceChannel.send({
        content: `@everyone\n${text}`,
        allowedMentions: { parse: ['everyone'] },
      });
      return interaction.editReply({ content: '✅ Posted!' });
    }

    if (isGiveawayRerollCommand) {
      const giveawayId = interaction.options.getString('giveaway', true);
      const replaceUser = interaction.options.getUser('replace');
      const result = await rerollGiveaway(giveawayId, replaceUser?.id);

      if (result.error) return interaction.editReply({ content: `⚠️ ${result.error}` });

      let reply = `✅ Reroll done — ${result.pairs.map(p => `<@${p.oldId}> → <@${p.newId}>`).join(', ')}`;
      if (result.notReplaced.length) {
        reply += `\n\n⚠️ Not enough eligible entrants to replace: ${result.notReplaced.map(id => `<@${id}>`).join(', ')} (kept as winner).`;
      }
      return interaction.editReply({ content: reply });
    }

    if (isAddBadServerCommand) {
      const identifier = interaction.options.getString('identifier').toLowerCase().trim();
      const label = interaction.options.getString('label');
      acDB.badServers[identifier] = { label, addedBy: interaction.user.id, addedAt: Date.now() };
      saveAntiCheatDB();
      return interaction.editReply({ content: `✅ Added **${label}** (\`${identifier}\`) to the watch list.` });
    }

    if (isRemoveBadServerCommand) {
      const identifier = interaction.options.getString('identifier').toLowerCase().trim();
      if (!acDB.badServers[identifier]) {
        return interaction.editReply({ content: `⚠️ \`${identifier}\` isn't on the watch list.` });
      }
      const label = acDB.badServers[identifier].label;
      delete acDB.badServers[identifier];
      saveAntiCheatDB();
      return interaction.editReply({ content: `✅ Removed **${label}** (\`${identifier}\`) from the watch list.` });
    }

    if (isListBadServersCommand) {
      const entries = Object.entries(acDB.badServers);
      const list = entries.length
        ? entries.map(([id, info]) => `• **${info.label}** — \`${id}\``).join('\n')
        : 'The watch list is empty.';
      return interaction.editReply({ content: `🚫 **Anti-Cheat Watch List**\n\n${list}` });
    }

    if (isFixPermsCommand) {
      // Clears any channel-specific permission override that targets the
      // bot's own member entry OR any role the bot has — everywhere in the
      // server. This does NOT grant any new permission; it only removes
      // per-channel exceptions, so the bot's role-level permissions (set in
      // Server Settings → Roles) end up applying identically in every channel.
      const guild = interaction.guild;
      const botMember = await guild.members.fetchMe();
      const botRoleIds = new Set(botMember.roles.cache.map(r => r.id));

      const channels = await guild.channels.fetch();
      let checked = 0;
      let cleared = 0;

      for (const [, channel] of channels) {
        if (!channel || !channel.permissionOverwrites || channel.isThread?.()) continue;
        checked++;
        for (const [overwriteId] of channel.permissionOverwrites.cache) {
          if (overwriteId === botMember.id || botRoleIds.has(overwriteId)) {
            try {
              await channel.permissionOverwrites.delete(overwriteId, `Cleared by /fixperms (${interaction.user.tag})`);
              cleared++;
            } catch (err) {
              console.error(`❌ fixperms: failed to clear override in #${channel.name}:`, err.message);
            }
          }
        }
      }

      return interaction.editReply({
        content: `✅ Checked ${checked} channels — cleared ${cleared} bot-specific permission override(s).\n\nThe bot's role permissions (from Server Settings → Roles) now apply the same in every channel.`,
      });
    }

    if (isDeleteMessageCommand) {
      const targetUser = interaction.options.getUser('user', true);
      const minutes = interaction.options.getInteger('minutes', true);
      const cutoff = Date.now() - minutes * 60 * 1000;
      const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

      const guild = interaction.guild;
      const botMember = await guild.members.fetchMe();
      const allChannels = await guild.channels.fetch();

      let totalDeleted = 0;
      let channelsScanned = 0;

      for (const [, channel] of allChannels) {
        if (!channel || !channel.isTextBased?.() || channel.isThread?.()) continue;
        const perms = channel.permissionsFor(botMember);
        if (!perms?.has(['ViewChannel', 'ReadMessageHistory', 'ManageMessages'])) continue;

        channelsScanned++;
        let beforeId;

        // Page backward through history 100 at a time until we pass the
        // requested time window or run out of messages in this channel.
        while (true) {
          const batch = await channel.messages.fetch({ limit: 100, ...(beforeId ? { before: beforeId } : {}) }).catch(() => null);
          if (!batch || batch.size === 0) break;
          beforeId = batch.last().id;

          const matching = batch.filter(m => m.author.id === targetUser.id && m.createdTimestamp >= cutoff);
          const passedCutoff = batch.some(m => m.createdTimestamp < cutoff);

          if (matching.size > 0) {
            // Discord's bulk-delete endpoint refuses messages older than 14
            // days — those have to go one at a time instead.
            const bulkable = matching.filter(m => Date.now() - m.createdTimestamp < FOURTEEN_DAYS_MS);
            const singleDeletable = matching.filter(m => Date.now() - m.createdTimestamp >= FOURTEEN_DAYS_MS);

            if (bulkable.size === 1) {
              await bulkable.first().delete().catch(() => {});
              totalDeleted += 1;
            } else if (bulkable.size > 1) {
              const deleted = await channel.bulkDelete(bulkable, true).catch(() => null);
              totalDeleted += deleted ? deleted.size : 0;
            }
            for (const m of singleDeletable.values()) {
              await m.delete().catch(() => {});
              totalDeleted++;
            }
          }

          if (passedCutoff || batch.size < 100) break; // this channel's history is now older than the window
        }
      }

      return interaction.editReply({
        content: `✅ Deleted ${totalDeleted} message(s) from ${targetUser} across ${channelsScanned} channel(s), from the last ${minutes} minute(s).\n\n-# Doesn't reach into threads — only regular channel history.`,
      });
    }

    if (isGiveawayCommand) {
      const prize = interaction.options.getString('prize');
      const minutes = interaction.options.getInteger('minutes');
      const winnersCount = interaction.options.getInteger('winners') || 1;

      const giveawayChannel = await client.channels.fetch(GIVEAWAY_CHANNEL_ID);
      const giveawayId = `ga_${Date.now()}_${interaction.user.id}`;
      const endsAt = Date.now() + minutes * 60 * 1000;

      const giveaway = {
        prize, endsAt, winnersCount,
        participants: new Set(),
        channelId: GIVEAWAY_CHANNEL_ID,
        messageId: null,
        ended: false,
        hostId: interaction.user.id,
        winners: [],
      };

      const sent = await giveawayChannel.send({
        components: [buildGiveawayContainer(giveaway), buildGiveawayButtonRow(giveawayId, false)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: ['everyone'] },
      });
      giveaway.messageId = sent.id;
      giveaways.set(giveawayId, giveaway);
      persistGiveaway(giveawayId);
      scheduleGiveawayEnd(giveawayId, endsAt - Date.now());

      return interaction.editReply({ content: `✅ Giveaway started in <#${GIVEAWAY_CHANNEL_ID}>!` });
    }

    const name = interaction.options.getString('name');
    const filepath = interaction.options.getString('filepath');
    const link = interaction.options.getString('link');
    const password = interaction.options.getString('password');
    const preview = interaction.options.getString('preview');

    const screenshots = [1, 2, 3, 4, 5]
      .map(i => interaction.options.getAttachment(`screenshot${i}`))
      .filter(Boolean);

    const targetChannelId = COMMAND_CHANNEL_MAP[interaction.commandName];
    const targetChannel = await client.channels.fetch(targetChannelId);

    const content = `@everyone\n${buildUploadContent({ name, link, password, preview, filepath })}`;
    const payload = { content, allowedMentions: { parse: ['everyone'] } };

    // Re-attach every uploaded screenshot so each renders as its own image
    // card, in addition to (or instead of) the auto-embedded video-link preview.
    if (screenshots.length) {
      payload.files = screenshots.map(s => ({ attachment: s.url, name: s.name }));
    }

    // Sent first — this is the message whose "preview" URL Discord auto-embeds
    // as a real video card. Any attachment placed in THIS message would render
    // ABOVE that video embed (a fixed Discord client rule, not something we
    // can reorder), so the footer/gif goes in a second message instead.
    await targetChannel.send(payload);

    const footerPayload = { content: `-# Uploaded by ${UPLOADER_TAG}` };
    if (interaction.commandName !== 'sneakpeekupload') {
      footerPayload.files = [{ attachment: BRAND_FOOTER_IMAGE_PATH, name: 'cartier-modz.gif' }];
    }
    await targetChannel.send(footerPayload);

    return interaction.editReply({ content: `✅ Posted in <#${targetChannelId}>!` });
  } catch (err) {
    console.error('❌ Command failed:', err);
    const payload = { content: '❌ Something went wrong — check the bot\'s permissions in that channel.', ephemeral: true };
    if (interaction.deferred) {
      await interaction.editReply(payload).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
 } catch (outerErr) {
  // Final safety net — nothing thrown inside this handler (including the
  // giveaway button branches above) should ever be able to crash the
  // process. Node 18+ terminates the whole app on an unhandled rejection,
  // which is what was crashing the bot and interrupting welcome messages.
  console.error('❌ Interaction handler error:', outerErr);
 }
});

// =========================================
// ✅ KEEP-ALIVE HTTP SERVER (Railway)
// =========================================
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running'); })
  .listen(process.env.PORT || 3000);

// =========================================
// ✅ GLOBAL SAFETY NET — never let one bad error kill the whole bot
// =========================================
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

client.login(process.env.TOKEN);
