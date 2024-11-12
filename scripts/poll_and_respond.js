const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slackToken = process.env.SLACK_BOT_TOKEN;
const openAiKey = process.env.OPENAI_API_KEY;
const slackClient = new WebClient(slackToken);

(async () => {
  try {
    // Step 1: Get bot's user ID
    const authResult = await slackClient.auth.test();
    const botUserId = authResult.user_id;

    // Step 2: Retrieve a list of all channels the bot is part of
    const channelsResult = await slackClient.conversations.list({
      types: 'public_channel,private_channel',
    });

    const channels = channelsResult.channels.filter(channel => channel.is_member);

    // Step 3: Loop through each channel and check recent messages
    for (const channel of channels) {
      const result = await slackClient.conversations.history({
        channel: channel.id,
        limit: 10,  // Adjust as needed to check more or fewer messages
      });

      // Step 4: Process messages that mention the bot
      for (const message of result.messages) {
        if (message.text.includes(`<@${botUserId}>`)) {
          // Generate a response using ChatGPT
          const chatGptResponse = await axios.post(
            'https://api.openai.com/v1/completions',
            {
              model: 'text-davinci-003',
              prompt: message.text,
              max_tokens: 50,
            },
            {
              headers: { Authorization: `Bearer ${openAiKey}` },
            }
          );

          // Post the response back to the channel
          await slackClient.chat.postMessage({
            channel: channel.id,
            text: chatGptResponse.data.choices[0].text.trim(),
          });
        }
      }
    }
  } catch (error) {
    console.error('Error running bot:', error);
  }
})();
