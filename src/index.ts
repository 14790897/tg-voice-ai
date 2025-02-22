import { createWorkersAI } from 'workers-ai-provider';
import { streamText } from 'ai';
import { generateText } from 'ai';

export interface Env {
	// aivoice: KVNamespace; // 可用于存储转录结果
	AI: Ai; // Cloudflare AI 模型服务
	tg_token: string; // Telegram 机器人 Token
	tg_chat_id: string; // Telegram 目标聊天 ID
	siliconflow_token: string; // SiliconFlow API Token
	tgvoicechat: KVNamespace;
}

export interface TelegramFileResponse {
	ok: boolean;
	result: {
		file_path: string;
	};
}

const WHISPER_MODEL = '@cf/openai/whisper'; // Whisper 模型路径
const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // Llama 模型路径
const TTS_MODEL = 'RVC-Boss/GPT-SoVITS'; // tts 模型路径

async function generateVoice(text: string, env: Env): Promise<Blob> {
	const apiUrl = 'https://api.siliconflow.cn/v1/audio/speech';
	const response = await fetch(apiUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.siliconflow_token}`, // 替换为实际的 API Token
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			input: text,
			voice: `${TTS_MODEL}:anna`, // 声音模型
			response_format: 'mp3', // 返回音频格式
			sample_rate: 32000, // 采样率
			stream: false, // 静态文件
			speed: 1, // 播放速度
			gain: 0, // 音量增益
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to generate voice: ${await response.text()}`);
	}
	console.log('Voice generated:');
	return await response.blob(); // 返回音频数据作为 Blob
}
// 上传文件至 Telegram
async function uploadVoiceToTelegram(blob: Blob, chatId: number, env: Env): Promise<Response> {
	const tgApiUrl = `https://api.telegram.org/bot${env.tg_token}/sendVoice`;

	const formData = new FormData();
	formData.append('chat_id', chatId.toString());
	formData.append('voice', blob, 'response.mp3'); // 将音频文件附加到 FormData 中，命名为 response.mp3

	const response = await fetch(tgApiUrl, {
		method: 'POST',
		body: formData,
	});

	if (!response.ok) {
		console.error('Failed to send voice to Telegram:', await response.text());
		throw new Error('Failed to send voice to Telegram');
	}
	console.log('Voice sent to Telegram:', await response.text());
	return response;
}

// 使用 Whisper 模型进行语音转录
async function transcribeAudio(blob: Blob, env: Env): Promise<string> {
	const audioArray = new Uint8Array(await blob.arrayBuffer()); // 转换 Blob 为 Uint8Array
	const response = await env.AI.run(WHISPER_MODEL, {
		audio: [...audioArray], // 将音频数据传递给 AI
	});
	return response.text; // 返回转录文本
}

async function getWebhookInfo(env: Env): Promise<any> {
	const webhookInfoUrl = `https://api.telegram.org/bot${env.tg_token}/getWebhookInfo`;

	const response = await fetch(webhookInfoUrl);
	const data = await response.json();

	return data;
}

async function storeChatHistory(chatId: number, messages: Array<{ role: string; text: string }>, env: Env): Promise<void> {
	const key = `chat_${chatId}`; // 使用聊天 ID 作为存储键
	const history = JSON.parse((await env.tgvoicechat.get(key)) || '[]'); // 从 KV 获取当前聊天记录
	const updatedHistory = [...history, ...messages].slice(-50); // 只保留最近 50 条记录
	await env.tgvoicechat.put(key, JSON.stringify(updatedHistory)); // 存回 KV
}
async function getChatHistory(chatId: number, env: Env): Promise<Array<{ role: string; text: string }>> {
	const key = `chat_${chatId}`; // 与存储消息时使用的键保持一致
	const history = JSON.parse((await env.tgvoicechat.get(key)) || '[]'); // 从 KV 中解析历史数据
	return history; // 返回聊天记录数组
}

// 修改注册逻辑，避免重复注册
async function registerTelegramWebhook(workerUrl: string, env: Env): Promise<any> {
	const webhookInfo = await getWebhookInfo(env);

	if (webhookInfo.result?.url === workerUrl) {
		// 当前 Webhook 已正确注册，无需重新设置
		return { ok: true, result: 'Webhook already registered', webhookInfo: webhookInfo.result };
	}

	const webhookApiUrl = `https://api.telegram.org/bot${env.tg_token}/setWebhook`;

	const body = JSON.stringify({
		url: workerUrl,
	});

	const response = await fetch(webhookApiUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
	});

	return await response.json();
}

// 获取 Telegram 文件的下载链接
async function getTelegramFileLink(fileId: string, env: Env): Promise<string> {
	const tgApiUrl = `https://api.telegram.org/bot${env.tg_token}/getFile?file_id=${fileId}`;
	const res = await fetch(tgApiUrl);
	const data: TelegramFileResponse = await res.json();

	if (!data.ok) {
		throw new Error(`Failed to get Telegram file: ${JSON.stringify(data)}`);
	}

	const filePath = data.result.file_path;
	return `https://api.telegram.org/file/bot${env.tg_token}/${filePath}`;
}

// 生成 AI 回复
async function generateAIResponse(prompt: string, chatHistory: Array<{ role: string; text: string }>, env: Env): Promise<string> {
	const workersai = createWorkersAI({ binding: env.AI });
	// 限制聊天历史为最近 10 条，并格式化为可读形式
	const limitedHistory = chatHistory.slice(-10); // 只保留最近 10 条记录
	const formattedHistory = limitedHistory
		.map(({ role, text }) => `${role === 'user' ? 'user' : 'aibot(me)'}: ${text}`) // 格式化记录
		.join('\n'); // 以换行符分隔
	// 拼接聊天历史作为上下文
	const result = await generateText({
		model: workersai(CHAT_MODEL), // 使用指定的 AI 模型
		prompt: `You are a good friend of the user, always accompanying them with humor and warmth. The user talks to you or chats with you through voice input, and the content may include unclear expressions. Please respond with a relaxed and understanding attitude, infer the user's true intent, and provide replies that are both fun and caring. Below is the user's recent chat history: ${formattedHistory}, and the user's current input is: ${prompt}.`, // 把识别出的文本作为输入 Prompt
	});
	console.log(`formattedHistory in generateAIResponse: ${formattedHistory}`);
	const response = result.text; // 获取完整的 AI 回复
	return response;
}

// 处理 Telegram 更新请求
async function handleTelegramUpdate(update: any, env: Env): Promise<Response> {
	try {
		const chatId = update.message.chat.id;
		const messageUrl = `https://api.telegram.org/bot${env.tg_token}/sendMessage`;
		let chatHistory: Array<{ role: string; text: string }> = [];
		try {
			chatHistory = await getChatHistory(chatId, env); // 获取聊天历史
		} catch (err) {
			console.error('Failed to fetch chat history:', err);
			chatHistory = []; // 使用空聊天历史作为兜底
		}
		if (!update.message?.voice) {
			const userText = update.message.text; // 读取文字内容

			console.log('No voice message found');
			const aiResponse = await generateAIResponse(userText, chatHistory, env);
			const telegramResponse = await fetch(messageUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text: aiResponse,
				}),
			});
			await storeChatHistory(
				chatId,
				[
					{ role: 'user', text: userText }, // 用户消息
					{ role: 'bot', text: aiResponse }, // AI 回复
				],
				env
			);
			// 生成语音回复
			const voiceBlob = await generateVoice(aiResponse, env);

			// 上传语音至 Telegram
			await uploadVoiceToTelegram(voiceBlob, chatId, env);
			return new Response('OK');
		}

		const fileId = update.message.voice.file_id;

		// 获取语音文件下载链接
		const fileUrl = await getTelegramFileLink(fileId, env);
		const audioResponse = await fetch(fileUrl);
		const blob = await audioResponse.blob();

		// 转录语音文件
		const transcription = await transcribeAudio(blob, env);

		// 基于转录结果生成 AI 回复
		const aiResponse = await generateAIResponse(transcription, chatHistory, env);

		// 回复用户转录结果和 AI 回复内容

		const telegramResponse = await fetch(messageUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `Your Transcription: ${transcription}  \n ${aiResponse}`,
			}),
		});
		if (!telegramResponse.ok) {
			console.error('Failed to send message to Telegram:', await telegramResponse.text());
			return new Response('OK');
		}
		await storeChatHistory(
			chatId,
			[
				{ role: 'user', text: transcription }, // 用户消息
				{ role: 'bot', text: aiResponse }, // AI 回复
			],
			env
		);
		// 生成语音回复
		const voiceBlob = await generateVoice(aiResponse, env);

		// 上传语音至 Telegram
		await uploadVoiceToTelegram(voiceBlob, chatId, env);
		return new Response('OK');
	} catch (error: any) {
		console.error('Error in handleTelegramUpdate:', error);
		return new Response('OK');
	}
}

export default {
	// 处理 Telegram Webhook 请求
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.tg_token || !env.siliconflow_token || !env.AI) {
			throw new Error('Environment variables are not properly configured.');
		}
		// Worker 运行时的 URL，需替换为实际 Worker 部署后的公共域名
		const workerUrl = request.url.replace('/init', '');
		console.log('Worker URL:', workerUrl);
		// const workerUrl = 'https://tg.14790897.xyz';

		// 确保在 Worker 部署时进行 Webhook 注册
		if (request.method === 'GET' && new URL(request.url).pathname === '/init') {
			const webhookResponse = await registerTelegramWebhook(workerUrl, env);
			return new Response(JSON.stringify(webhookResponse), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		try {
			const update = await request.json(); // 获取 Telegram 更新内容
			console.log('Received Telegram update:', update);
			// return new Response('你好，我是语音转文字机器人，我会将你的语音转换为文字并回复给你。', { status: 200 });
			return await handleTelegramUpdate(update, env); // 处理 Telegram 更新
		} catch (error) {
			console.error('Error handling Telegram update:', error);
			return new Response('OK');
		}
	},
} satisfies ExportedHandler<Env>;
