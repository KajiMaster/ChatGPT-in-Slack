const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slackToken = process.env.SLACK_BOT_TOKEN;
const openAiKey = process.env.OPENAI_API_KEY;
console.log("OpenAI API Key:", openAiKey ? "Loaded" : "Not found");
console.log("Slack Bot Token:", slackToken ? "Loaded" : "Not found");

const slackClient = new WebClient(slackToken);
const respondedMessages = new Set();
const conversationHistory = {};  // Store full conversation history by channel
const channelLastActive = {};
const HISTORY_LIMIT = 10;  // Number of recent exchanges to retain for context
const TIMESTAMP_CLEANUP_INTERVAL = 4 * 60 * 60 * 1000;
const MESSAGE_EXPIRY_TIME = 12 * 60 * 60 * 1000;
const CHANNEL_EXPIRY_TIME = 24 * 60 * 60 * 1000;
const MESSAGE_THRESHOLD = 45 * 1000;  // 45 seconds in milliseconds

// Periodic cleanup of old timestamps and inactive channels
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const ts of respondedMessages) {
    if (now - parseFloat(ts) * 1000 > MESSAGE_EXPIRY_TIME) {
      respondedMessages.delete(ts);
    }
  }
  console.log("Old timestamps cleaned up");

  for (const channelId in channelLastActive) {
    if (now - channelLastActive[channelId] > CHANNEL_EXPIRY_TIME) {
      delete conversationHistory[channelId];
      delete channelLastActive[channelId];
      console.log(`Cleared conversation history for inactive channel: ${channelId}`);
    }
  }
}, TIMESTAMP_CLEANUP_INTERVAL);

(async () => {
  try {
    // Step 1: Get bot's user ID
    const authResult = await slackClient.auth.test();
    const botUserId = authResult.user_id;
    console.log("Bot user ID:", botUserId);

    // Step 2: Retrieve a list of all channels the bot is part of
    const channelsResult = await slackClient.conversations.list({
      types: 'public_channel,private_channel',
    });

    const channels = channelsResult.channels.filter(channel => channel.is_member);
    console.log("Channels found:", channels.map(c => c.name).join(", "));

    // Step 3: Loop through each channel and check recent messages
    const now = Date.now();
    for (const channel of channels) {
      const result = await slackClient.conversations.history({
        channel: channel.id,
        limit: 10,
      });

      for (const message of result.messages) {
        const messageTime = parseFloat(message.ts) * 1000;

        if (respondedMessages.has(message.ts) || !message.text.includes(`<@${botUserId}>`) || (now - messageTime > MESSAGE_THRESHOLD)) {
          continue;
        }

        console.log("Message found mentioning bot:", message.text);
        respondedMessages.add(message.ts);

        channelLastActive[channel.id] = now;

        if (!conversationHistory[channel.id]) {
          conversationHistory[channel.id] = [];
        }
        // Add user's message to history
        conversationHistory[channel.id].push({ role: 'user', content: message.text });

        // Trim conversation history to the last HISTORY_LIMIT exchanges
        if (conversationHistory[channel.id].length > HISTORY_LIMIT * 2) {
          conversationHistory[channel.id].splice(0, 2);
        }

        try {
          // Create a structured message list to give context to ChatGPT
          const formattedMessages = conversationHistory[channel.id].map((msg) => {
            return {
              role: msg.role,
              content: msg.content,
            };
          });

          const chatGptResponse = await Promise.race([
            axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: "gpt-4", // Use the specific model name
                messages: formattedMessages,
                max_tokens: 300,
              },
              {
                headers: { Authorization: `Bearer ${openAiKey}` },
              }
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ChatGPT response timeout')), 15000))
          ]);

          const responseText = chatGptResponse.data.choices[0]?.message?.content?.trim();
          if (!responseText) {
            console.error("No valid response text from ChatGPT.");
            continue;
          }

          console.log("ChatGPT response:", responseText);

          // Add bot's response to the conversation history
          conversationHistory[channel.id].push({ role: 'assistant', content: responseText });

          // Split the response if it exceeds Slack's 4000-character limit
          const chunkSize = 4000;
          for (let i = 0; i < responseText.length; i += chunkSize) {
            const messageChunk = responseText.substring(i, i + chunkSize);
            const postResponse = await slackClient.chat.postMessage({
              channel: channel.id,
              text: messageChunk,
            });
            console.log("Posted message chunk to Slack:", messageChunk);
            console.log("Slack response:", postResponse.ok ? "Message sent successfully" : "Message failed to send");
          }

        } catch (axiosError) {
          console.error("Error with ChatGPT response:", axiosError.message, axiosError.response?.data || axiosError);
        }
      }
    }
  } catch (error) {
    console.error('Error running bot:', error);
  } finally {
    clearInterval(cleanupInterval);
    process.exit(0);
  }
})();
