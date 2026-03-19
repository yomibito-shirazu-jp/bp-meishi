
import { GoogleGenAI, Type, Modality, FunctionDeclaration } from "@google/genai";
import { BriefingItem, TriageEmail } from "../types";
import { MCPService, isReauthRequired } from "./mcpService";

const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY! });

const tools: FunctionDeclaration[] = [
  {
    name: "manage_calendar",
    description: "カレンダーの予定を確認し、関連する準備物を特定します。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: "list, get_details" },
        date: { type: Type.STRING, description: "YYYY-MM-DD format" },
        eventId: { type: Type.STRING }
      },
      required: ["action"]
    }
  },
  {
    name: "search_context",
    description: "Google ワークスペース（Drive/Gmail）から、予定に関連するキーワード（プロジェクト名、会社名、参加者）で資料とメールスレッドを検索し、文脈を把握します。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        queries: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "検索キーワードのリスト"
        },
        includeEmails: { type: Type.BOOLEAN, description: "メールスレッドを含めるか" }
      },
      required: ["queries"]
    }
  },
  {
    name: "summarize_thread",
    description: "特定のメールスレッドのやり取りを要約し、会議の背景や決定事項を抽出します。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        threadId: { type: Type.STRING }
      },
      required: ["threadId"]
    }
  },
  {
    name: "google_search",
    description: "最新のウェブ情報を検索します。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING }
      },
      required: ["query"]
    }
  },
  {
    name: "google_maps",
    description: "場所の検索や移動ルートの検索を行います。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: { type: Type.STRING },
        query: { type: Type.STRING }
      },
      required: ["query"]
    }
  },
  {
    name: "send_email",
    description: "メールを送信します。社長の承認が必要です。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING },
        subject: { type: Type.STRING },
        body: { type: Type.STRING }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "update_calendar",
    description: "カレンダーの予定を作成または更新します。社長の承認が必要です。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        start: { type: Type.STRING },
        end: { type: Type.STRING },
        description: { type: Type.STRING }
      },
      required: ["title", "start"]
    }
  }
];

const CRITICAL_TOOLS = ["send_email", "update_calendar"];

const EXECUTIVE_INSTRUCTIONS = `あなたは「NEXUS」という名の経営者専属秘書です。
Google ワークスペースの会議「資料（ファイル）」と「経緯（メール）」を統合して社長に報告することがあなたの使命です。

行動指針：
1. 予定の多角的な分析：予定名と参加者から、「何を決めるための会議か」を理解してください。
2. 関連するメールの特定：会議のきっかけとなったメールスレッドを特定し、これまでの議論の流れを把握してください。
3. 統合的なご報告：単にファイルを出すだけでなく、「メールでは〇〇で合意済みですが、今回の資料では××が更新されています」というように、情報の繋がりを伝えてください。
4. 意思決定の支援：判明した事実に基づき、「今日はこの点を決める必要があります」と社長にアドバイスしてください。

口調：常に一歩先を読み、社長が自信を持って会議に臨めるようサポートする、極めて優秀な秘書として振る舞ってください。`;

const GOOGLE_API_TOOLS = ['manage_calendar', 'search_context', 'summarize_thread'];

// Mock Tool Execution (Phase 2 integration placeholder)
const executeTool = async (name: string, args: any) => {
  if (GOOGLE_API_TOOLS.includes(name) && isReauthRequired()) {
    console.warn("Blocked tool execution due to reauth required");
    throw new Error("REAUTHENTICATION_REQUIRED");
  }
  console.log(`Executing real tool: ${name}`, args);
  try {
    switch (name) {
      case 'manage_calendar':
        if (args.action === 'list') {
          const events = await MCPService.listCalendarEvents();
          return events.map((e: any) => ({
            id: e.id,
            title: e.summary,
            start: e.start?.dateTime || e.start?.date,
            location: e.location,
            attendees: e.attendees?.map((a: any) => a.displayName || a.email)
          }));
        }
        return "Action not supported yet";

      case 'search_context':
        const [threads, files] = await Promise.all([
          MCPService.listGmailThreads(args.queries.join(' ')),
          MCPService.listDriveFiles(args.queries.join(' '))
        ]);

        const emailContext = await Promise.all(threads.slice(0, 3).map(async (t: any) => {
          const detail = await MCPService.getGmailThread(t.id);
          const snippet = detail.messages?.[0]?.snippet || "";
          const from = detail.messages?.[0]?.payload?.headers?.find((h: any) => h.name === 'From')?.value || "Unknown";
          const subject = detail.messages?.[0]?.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || "No Subject";
          return { from, subject, snippet, threadId: t.id };
        }));

        const fileContext = files.map((f: any) => ({
          name: f.name,
          type: f.mimeType.split('.').pop() || 'file',
          url: f.webViewLink
        }));

        return { emails: emailContext, files: fileContext };

      case 'summarize_thread':
        const thread = await MCPService.getGmailThread(args.threadId);
        return thread.messages?.map((m: any) => m.snippet).join('\n---\n') || "No content";

      case 'google_search':
        // Fallback to mock search if no real tool configured in this context
        return { results: [{ title: `${args.query} の検索結果`, url: 'https://www.google.com/search?q=' + encodeURIComponent(args.query), snippet: 'Googleでのリアルタイム検索結果です。' }] };

      case 'google_maps':
        return { location: args.query || args.location, travel_time: '12 mins' };

      default:
        return "Function not implemented";
    }
  } catch (e) {
    console.error(`Tool ${name} execution failed:`, e);
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    if (errorMsg.includes("No refresh token") || errorMsg.includes("reauthenticate") || errorMsg.includes("REAUTHENTICATION_REQUIRED")) {
      // UIで検知可能な特別なエラーを投げる
      throw new Error("REAUTHENTICATION_REQUIRED");
    }
    return `Error: ${errorMsg}`;
  }
};

export const getExecutiveAction = async (prompt: string | any[], modelName: string = 'gemini-2.5-flash', chatHistory?: any[]) => {
  const ai = getAI();

  // prompt can be a string or tool results array
  const currentTurn = typeof prompt === 'string' ? { role: 'user', parts: [{ text: prompt }] } : { role: 'user', parts: prompt };
  const contents = [...(chatHistory || []), currentTurn];

  let result = await ai.models.generateContent({
    model: modelName,
    contents,
    config: {
      systemInstruction: EXECUTIVE_INSTRUCTIONS,
      tools: [{ functionDeclarations: tools }],
    },
  });

  let functionCalls = result.functionCalls;

  while (functionCalls && functionCalls.length > 0) {
    // Check for critical tools that need confirmation
    const criticalCall = functionCalls.find(call => CRITICAL_TOOLS.includes(call.name));
    if (criticalCall) {
      return {
        text: result.text || "こちらの操作を実行してもよろしいでしょうか？",
        pendingToolCall: criticalCall,
        grounding: (result as any).candidates?.[0]?.groundingMetadata
      };
    }

    const toolResponses = await Promise.all(
      functionCalls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: { content: await executeTool(call.name, call.args) }
        }
      }))
    );

    // Append the assistant's tool call and the tool responses to history
    contents.push({ role: 'model', parts: result.candidates?.[0]?.content?.parts || [] });
    contents.push({ role: 'user', parts: toolResponses as any });

    result = await ai.models.generateContent({
      model: modelName,
      contents,
      config: {
        systemInstruction: EXECUTIVE_INSTRUCTIONS,
        tools: [{ functionDeclarations: tools }],
      },
    });
    functionCalls = result.functionCalls;
  }

  return {
    text: result.text || "",
    grounding: (result as any).candidates?.[0]?.groundingMetadata
  };
};

export const executeApprovedTool = async (call: any, chatHistory: any[]) => {
  const response = await executeTool(call.name, call.args);
  return getExecutiveAction([{
    functionResponse: {
      name: call.name,
      response: { content: response }
    }
  }] as any, 'gemini-2.5-flash', chatHistory);
};

export const generateBriefing = async (currentTime: string): Promise<(BriefingItem | TriageEmail)[]> => {
  const prompt = `現在時刻は ${currentTime} です。
まずは 'manage_calendar' を使って本日のスケジュールを確認してください。
その後、関連するメールがあれば 'search_context' で詳細を確認し、
重要な未読メールがあればそれも含めて、社長のための今日のブリーフィングレポートを作成してください。
※必ず実際のツールを使って取得した情報を元にしてください。サンプルデータは使わないでください。

出力形式は必ず以下の要件を満たすJSON配列にしてください。マークダウンのコードブロックは不要です。生のリザルトテキストだけで返してください。
[
  {
    "id": "1",
    "type": "schedule",
    "time": "14:00",
    "title": "予定名",
    "summary": "要約テキスト",
    "urgency": "high",
    "context": {
      "emails": [{"from": "送信者", "subject": "件名", "snippet": "本文一部"}],
      "files": [{"name": "ファイル名", "type": "pdf"}]
    }
  }
]`;

  const res = await getExecutiveAction(prompt);
  try {
    // Gemini may wrap JSON in code blocks
    const jsonStr = res.text.replace(/```json|```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse briefing JSON:", e, res.text);
    return [];
  }
};

export const speakContent = async (text: string): Promise<Uint8Array> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    } as any,
  });

  const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64) throw new Error("Audio generation failed");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
};

export async function decodeAndPlayAudio(data: Uint8Array): Promise<void> {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const dataInt16 = new Int16Array(data.buffer);
  const buffer = audioContext.createBuffer(1, dataInt16.length, 24000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < dataInt16.length; i++) {
    channelData[i] = dataInt16[i] / 32768.0;
  }
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
}
