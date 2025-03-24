require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { ChatOpenAI } = require('@langchain/openai');
const { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } = require('@aptos-labs/ts-sdk');
const { AgentRuntime, LocalSigner, createAptosTools } = require('move-agent-kit');
const { MemorySaver } = require('@langchain/langgraph');
const { createReactAgent } = require('@langchain/langgraph/prebuilt');
const { HumanMessage } = require('@langchain/core/messages');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const memorySaver = new MemorySaver();

// MongoDB Initialization
const client = new MongoClient(process.env.MONGODB_URI);
let db; 
async function connectDB() {
  await client.connect();
  db = client.db(process.env.MONGODB_DB_NAME);
}
connectDB();

// Function to get or create a user's Aptos wallet
async function getOrCreateUserWallet(userId) {
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });

  if (userDoc) {
    const privateKey = new Ed25519PrivateKey(
      PrivateKey.formatPrivateKey(userDoc.privateKey, PrivateKeyVariants.Ed25519)
    );
    const AptosAccount = Account.fromPrivateKey({ privateKey });
    return { AptosAccount, address: userDoc.publicKey };
  }

  const AptosAccount = Account.generate();
  await userCollection.insertOne({
    userId,
    publicKey: AptosAccount.publicKey.toString(),
    privateKey: AptosAccount.privateKey.toString(),
    alertsEnabled: false,
  });

  return { AptosAccount, address: AptosAccount.publicKey.toString() };
}

// Function to initialize Move AI Agent
async function initializeAgent(userId, AptosAccount) {
  const llm = new ChatOpenAI({
    modelName: "gpt-4-turbo",
    temperature: 0.7,
    openAIApiKey: process.env.OPENAI_API_KEY, 
  });

  const aptosConfig = new AptosConfig({ network: Network.MAINNET });
  const aptos = new Aptos(aptosConfig);
  const signer = new LocalSigner(AptosAccount, Network.MAINNET);
  const aptosAgent = new AgentRuntime(signer, aptos, { OPENSEA_API_KEY: process.env.OPENSEA_API_KEY });
  const tools = createAptosTools(aptosAgent);

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memorySaver,
    messageModifier: "You are a helpful agent that interacts on-chain using Move Agent Kit.",
  });

  return { agent, config: { configurable: { thread_id: userId } } };
}

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const { address } = await getOrCreateUserWallet(userId);

  await ctx.replyWithHTML(
    `<b>👋 Welcome to Aptos Assistant Bot! 🚀</b>\n\n` +
    `<b>🏦 Your Wallet Address:</b>\n<code>${address}</code>\n\n` +
    `<b>💬 Ask AI:</b>\n` +
    `• "What’s my Aptos balance?"\n` +
    `• "Send 1 APT to xyz…"\n` +
    `• "How much gas is needed for a transaction?"\n\n` +
    `<b>📢 Real-Time Alerts:</b>\n• Receive notifications for transactions.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ Settings", "settings")]
    ])
  );
});

// Settings menu
bot.action("settings", async (ctx) => {
  await ctx.replyWithHTML(
    `<b>⚙️ Settings Menu</b>\nChoose an option below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🔑 View Private Key", "view_private_key")],
      [Markup.button.callback("🏦 View Wallet Address", "view_wallet")],
      [Markup.button.callback("🔔 Toggle Alerts", "toggle_alerts")]
    ])
  );
  await ctx.answerCbQuery();
});

// View Private Key (Sent in DM)
bot.action("view_private_key", async (ctx) => {
  const userId = ctx.from.id.toString();
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });

  if (userDoc) {
    await ctx.telegram.sendMessage(userId, 
      `<b>🔑 Your Private Key:</b>\n<code>${userDoc.privateKey}</code>\n\n<b>⚠️ Keep this private! Do NOT share it.</b>`, 
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.replyWithHTML(`<b>❌ No private key found.</b>\nPlease create or import an account.`);
  }

  await ctx.answerCbQuery();
});


// View Wallet Address
bot.action("view_wallet", async (ctx) => {
  const userId = ctx.from.id.toString();
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });

  if (userDoc) {
    await ctx.replyWithHTML(
      `<b>🏦 Your Wallet Address:</b>\n<code>${userDoc.publicKey}</code>`
    );
  } else {
    await ctx.replyWithHTML(`<b>❌ No wallet found.</b>\nPlease create or import an account.`);
  }

  await ctx.answerCbQuery();
});

// Toggle Alerts
bot.action("toggle_alerts", async (ctx) => {
  const userId = ctx.from.id.toString();
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });

  if (!userDoc) {
    await ctx.replyWithHTML(`<b>❌ No account found.</b>\nPlease create or import an account.`);
    return;
  }

  const newAlertStatus = !userDoc.alertsEnabled;
  await userCollection.updateOne({ userId }, { $set: { alertsEnabled: newAlertStatus } });

  await ctx.replyWithHTML(newAlertStatus ? 
    `<b>🔔 Alerts Enabled!</b>\nYou will receive notifications for transactions.` : 
    `<b>🔕 Alerts Disabled!</b>\nYou will no longer receive notifications.`
  );

  await ctx.answerCbQuery();
});

// AI Interaction (Handles user messages)
bot.on("text", async (ctx) => {
  const userId = ctx.from.id.toString();
  const { AptosAccount } = await getOrCreateUserWallet(userId);
  const { agent, config } = await initializeAgent(userId, AptosAccount);

  // Show "typing..." indicator
  await ctx.telegram.sendChatAction(ctx.chat.id, "typing");

  const stream = await agent.stream({ messages: [new HumanMessage(ctx.message.text)] }, config);
  
  for await (const chunk of stream) {
    if (chunk.agent?.messages[0]?.content) {
      const response = chunk.agent.messages[0].content;

      // Format message properly with HTML
      const formattedResponse = `${response}`;

      await ctx.replyWithHTML(formattedResponse, {
        reply_to_message_id: ctx.message.message_id,
      });
    }
  }
});



// Start the bot
bot.launch();