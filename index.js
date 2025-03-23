require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { Account, Aptos, AptosConfig, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } = require('@aptos-labs/ts-sdk');
const { AgentRuntime, LocalSigner, createAptosTools } = require('move-agent-kit');
const { ChatAnthropic } = require('@langchain/anthropic');
const { MemorySaver } = require('@langchain/langgraph');
const { createReactAgent } = require('@langchain/langgraph/prebuilt');
const { HumanMessage } = require('@langchain/core/messages');
const { ChatOpenAI } = require('@langchain/openai');



const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const memorySaver = new MemorySaver();
const userImportState = new Map();

// MongoDB Initialization
const client = new MongoClient(process.env.MONGODB_URI);
let db;
async function connectDB() {
  await client.connect();
  db = client.db(process.env.MONGODB_DB_NAME);
}
connectDB();

async function getOrCreateUserWallet(userId) {
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });
  if (userDoc) {
    const privateKey = new Ed25519PrivateKey(
      PrivateKey.formatPrivateKey(userDoc.privateKey, PrivateKeyVariants.Ed25519)
    );
    const AptosAccount = Account.fromPrivateKey({ privateKey });
    return { AptosAccount, inProgress: userDoc.inProgress };
  }
  const AptosAccount = Account.generate();
  await userCollection.insertOne({
    userId,
    publicKey: AptosAccount.publicKey.toString(),
    privateKey: AptosAccount.privateKey.toString(),
    inProgress: false,
    inGame: false,
  });
  return { AptosAccount, inProgress: false };
}

async function initializeAgent(userId, AptosAccount) {
  const llm = new ChatOpenAI({
    modelName: "gpt-4-turbo",
    temperature: 0.7,
    openAIApiKey: process.env.OPENAI_API_KEY, 
  });

  const aptosConfig = new AptosConfig({ network: Network.MAINNET });
  const aptos = new Aptos(aptosConfig);
  const signer = new LocalSigner(AptosAccount, Network.MAINNET);
  const aptosAgent = new AgentRuntime(signer, aptos, { PANORA_API_KEY: process.env.PANORA_API_KEY });
  const tools = createAptosTools(aptosAgent);
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memorySaver,
    messageModifier: "You are a helpful agent that interacts on-chain using Move Agent Kit. Be concise and helpful.",
  });
  return { agent, config: { configurable: { thread_id: userId } } };
}

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const userCollection = db.collection('users');
  const userDoc = await userCollection.findOne({ userId });
  if (!userDoc) {
    await ctx.reply("Welcome! Choose an option:", Markup.inlineKeyboard([
      [Markup.button.callback("Create New Account", "create_account")],
      [Markup.button.callback("Import Existing Account", "import_account")]
    ]));
  }
});

bot.action("create_account", async (ctx) => {
  const userId = ctx.from.id.toString();
  const { AptosAccount } = await getOrCreateUserWallet(userId);
  await ctx.reply("Your new account has been created! Wallet Address: " + AptosAccount.publicKey.toString());
  await ctx.answerCbQuery();
});

bot.action("import_account", async (ctx) => {
  const userId = ctx.from.id.toString();
  userImportState.set(userId, true);
  await ctx.reply("Send your private key (64-character hex format).");
  await ctx.answerCbQuery();
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id.toString();
  const privateKeyInput = ctx.message.text;
  if (userImportState.get(userId)) {
    if (!/^[0-9a-fA-F]{64}$/.test(privateKeyInput)) {
      await ctx.reply("Invalid private key format. Try again.");
      return;
    }
    const AptosAccount = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(privateKeyInput, PrivateKeyVariants.Ed25519))
    });
    const userCollection = db.collection('users');
    await userCollection.updateOne(
      { userId },
      { $set: {
        publicKey: AptosAccount.publicKey.toString(),
        privateKey: AptosAccount.privateKey.toString(),
        inProgress: false,
        inGame: false,
      } },
      { upsert: true }
    );
    await ctx.reply("Account imported! Wallet Address: " + AptosAccount.publicKey.toString());
    userImportState.delete(userId);
  }
  const { AptosAccount } = await getOrCreateUserWallet(userId);
  const { agent, config } = await initializeAgent(userId, AptosAccount);
  const stream = await agent.stream({ messages: [new HumanMessage(ctx.message.text)] }, config);
  for await (const chunk of stream) {
    if (chunk.agent?.messages[0]?.content) {
      await ctx.reply(chunk.agent.messages[0].content);
    }
  }
});

bot.launch();
