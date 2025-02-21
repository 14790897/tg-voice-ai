# **电报语音对话机器人**

## 功能

发送语音或者文字，收到语音+文字的聊天回复

## **使用方法**

### 我部署的

https://t.me/tg_voice_ai_bot 可以直接使用

### 自己部署

1. 在 botfather 创建机器人
2. 部署 cf 程序

   ```sh
   npm install
   npm install -g wrangler
   wrangler login # 登录cf
   wrangler kv namespace create tgvoicechat # 创建kv
	<!-- 修改 wrangler.json 中的 kv_namespaces 的 id 为上一步创建返回的 kv id  -->
   npm run deploy
   ```

3. cf 配置环境变量（secret类型） tg_token(botfather 给出的 token) 和 siliconflow_token（硅基的 api token 用于生成语音，因为 workers ai 没有 tts 功能）
4. 访问 worker 域名/init 进行电报 webhook 注册

5. 与机器人聊天，支持语音和文字
6. 可以在代码中修改使用模型

   ```ts
   const WHISPER_MODEL = '@cf/openai/whisper'; // Whisper 模型路径
   const CHAT_MODEL = '@cf/meta/llama-2-7b-chat-int8'; // Llama 模型路径
   const TTS_MODEL = 'RVC-Boss/GPT-SoVITS'; // tts 模型路径
   ```

## 演示

![alt text](image.png)
