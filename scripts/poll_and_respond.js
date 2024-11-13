const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slackToken = process.env.SLACK_BOT_TOKEN;
const openAiKey = process.env.OPENAI_API_KEY;
console.log("OpenAI API Key:", openAiKey ? "Loaded" : "Not found");
console.log("Slack Bot Token:", slackToken ? "Loaded" : "Not found");

const slackClient = new WebClient(slackToken);
const respondedMessages = new Set();  // Store timestamps of processed messages
const TIMESTAMP_CLEANUP_INTERVAL = 4 * 60 * 60 * 1000;  // 4 hours in milliseconds
const MESSAGE_EXPIRY_TIME = 12 * 60 * 60 * 1000;        // 12 hours in milliseconds
const MESSAGE_THRESHOLD = 10 * 1000;  // 10 seconds in milliseconds

// Periodic cleanup of old timestamps
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const ts of respondedMessages) {
    if (now - parseFloat(ts) * 1000 > MESSAGE_EXPIRY_TIME) {
      respondedMessages.delete(ts);  // Remove old message timestamps
    }
  }
  console.log("Old timestamps cleaned up");
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

        // Generate a response using ChatGPT with a timeout
        try {
          const chatGptResponse = await Promise.race([
            axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: "gpt-4",  // Use the specific model name you have access to
                messages: [
                  { role: 'user', content: message.text }
                ],
                max_tokens: 200,
              },
              {
                headers: { Authorization: `Bearer ${openAiKey}` },
              }
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ChatGPT response timeout')), 15000))  // 15-second timeout
          ]);

          const responseText = chatGptResponse.data.choices[0].message.content.trim();
          console.log("ChatGPT response:", responseText);

          // Split the response if it exceeds Slack's 4000-character limit
          const chunkSize = 4000;
          for (let i = 0; i < responseText.length; i += chunkSize) {
            const messageChunk = responseText.substring(i, i + chunkSize);
            await slackClient.chat.postMessage({
              channel: channel.id,
              text: messageChunk,
            });
          }

        } catch (error) {
          console.error("Error with ChatGPT response:", error.message);
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
