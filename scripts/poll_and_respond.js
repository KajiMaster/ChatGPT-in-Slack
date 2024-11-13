const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slackToken = process.env.SLACK_BOT_TOKEN;
const openAiKey = process.env.OPENAI_API_KEY;
console.log("OpenAI API Key:", openAiKey ? "Loaded" : "Not found");
console.log("Slack Bot Token:", slackToken ? "Loaded" : "Not found");

const slackClient = new WebClient(slackToken);
const respondedMessages = new Set();  // Store timestamps of processed messages
const conversationHistory = {};       // Store conversation history by channel
const channelLastActive = {};         // Track last activity for each channel
const HISTORY_LIMIT = 5;              // Number of recent messages to retain in history per channel
const TIMESTAMP_CLEANUP_INTERVAL = 4 * 60 * 60 * 1000;  // 4 hours in milliseconds
const MESSAGE_EXPIRY_TIME = 12 * 60 * 60 * 1000;        // 12 hours in milliseconds
const CHANNEL_EXPIRY_TIME = 24 * 60 * 60 * 1000;        // Expire channels after 24 hours of inactivity
const MESSAGE_THRESHOLD = 45 * 1000;  // 45 seconds in milliseconds

// Periodic cleanup of old timestamps and inactive channels
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  // Cleanup expired message timestamps
  for (const ts of respondedMessages) {
    if (now - parseFloat(ts) * 1000 > MESSAGE_EXPIRY_TIME) {
      respondedMessages.delete(ts);
    }
  }
  console.log("Old timestamps cleaned up");

  // Cleanup inactive channels
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
        limit: 10,  // Adjust as needed to check more or fewer messages
      });

      // Step 4: Process messages that mention the bot
      for (const message of result.messages) {
        const messageTime = parseFloat(message.ts) * 1000;

        // Skip if message was already processed, does not mention the bot, or is older than the threshold
        if (respondedMessages.has(message.ts) || !message.text.includes(`<@${botUserId}>`) || (now - messageTime > MESSAGE_THRESHOLD)) {
          continue;
        }

        console.log("Message found mentioning bot:", message.text);
        respondedMessages.add(message.ts);  // Mark this message as responded to

        // Update channel's last activity
        channelLastActive[channel.id] = now;

        // Add the new message to the conversation history
        if (!conversationHistory[channel.id]) {
          conversationHistory[channel.id] = [];
        }
        conversationHistory[channel.id].push({ role: 'user', content: message.text });

        // Trim conversation history to the last HISTORY_LIMIT messages
        if (conversationHistory[channel.id].length > HISTORY_LIMIT) {
          conversationHistory[channel.id].shift();
        }

        // Generate a response using ChatGPT with a timeout
        try {
          const chatGptResponse = await Promise.race([
            axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: "gpt-4",  // Use the specific model name you have access to
                messages: conversationHistory[channel.id],
                max_tokens: 200,
              },
              {
                headers: { Authorization: `Bearer ${openAiKey}` },
              }
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ChatGPT response timeout')), 15000))  // 15-second timeout
          ]);

          const responseText = chatGptResponse.data.choices[0]?.message?.content?.trim();
          if (!responseText) {
            console.error("No valid response text from ChatGPT.");
            continue;
          }

          console.log("ChatGPT response:", responseText);

          // Add the bot's response to the conversation history
          conversationHistory[channel.id].push({ role: 'assistant', content: responseText });

          // Split the response if it exceeds Slack's 4000-character limit
          const chunkSize = 4000;
          for (let i = 0; i < responseText.length; i += chunkSize) {
            const messageChunk = responseText.substring(i, i + chunkSize);
            await slackClient.chat.postMessage({
              channel: channel.id,
              text: messageChunk,
            });
            console.log("Posted message chunk to Slack:", messageChunk);
          }

        } catch (axiosError) {
          console.error("Error with ChatGPT response:", axiosError.message, axiosError.response?.data || axiosError);
        }
      }
    }
  } catch (error) {
    console.error('Error running bot:', error);
  } finally {
    clearInterval(cleanupInterval);  // Clear the interval to allow the process to exit
    process.exit(0);  // Explicitly exit the process
  }
})();
