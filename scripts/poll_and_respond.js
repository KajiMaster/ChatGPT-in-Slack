const { WebClient } = require('@slack/web-api');
const axios = require('axios');

const slackToken = process.env.SLACK_BOT_TOKEN;
const openAiKey = process.env.OPENAI_API_KEY;
console.log("OpenAI API Key:", openAiKey ? "Loaded" : "Not found");
console.log("Slack Bot Token:", slackToken ? "Loaded" : "Not found");

const slackClient = new WebClient(slackToken);

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
    for (const channel of channels) {
      const result = await slackClient.conversations.history({
        channel: channel.id,
        limit: 10,  // Adjust as needed to check more or fewer messages
      });

      // Step 4: Process messages that mention the bot
      for (const message of result.messages) {
        if (message.text.includes(`<@${botUserId}>`)) {
          console.log("Message found mentioning bot:", message.text);

          // Generate a response using ChatGPT
          try {
            const chatGptResponse = await axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: "gpt-4o",  // Use the specific model name you have access to
                messages: [
                  { role: 'user', content: message.text }
                ],
                max_tokens: 50,
              },
              {
                headers: { Authorization: `Bearer ${openAiKey}` },
              }
            );

            console.log("ChatGPT response:", chatGptResponse.data.choices[0].message.content.trim());

            // Post the response back to the channel
            await slackClient.chat.postMessage({
              channel: channel.id,
              text: chatGptResponse.data.choices[0].message.content.trim(),
            });
          } catch (axiosError) {
            console.error("Error with OpenAI API request:", axiosError.response?.status, axiosError.response?.data);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error running bot:', error);
  }
})();
