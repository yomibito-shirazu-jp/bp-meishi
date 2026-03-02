import { GoogleGenAI, Type } from "@google/genai";
import { CardData, ElementStyle } from "../types";

const parseJSON = (text: string) => {
    try {
        const match = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (match) {
            return JSON.parse(match[1]);
        }
        return JSON.parse(text);
    } catch (e) {
        console.error("Failed to parse JSON", e);
        return null;
    }
};

const createDefaultLayout = (): Record<string, ElementStyle> => {
    // Basic stacked layout to start with
    const baseStyle: ElementStyle = {
        x: 20, y: 20, fontSize: 12, fontFamily: 'Noto Sans JP', fontWeight: 'normal', color: '#000000', textAlign: 'left'
    };
    
    return {
        companyName: { ...baseStyle, x: 20, y: 30, fontSize: 14, fontWeight: 'bold' },
        title: { ...baseStyle, x: 20, y: 60, fontSize: 10, color: '#555555' },
        fullName: { ...baseStyle, x: 20, y: 90, fontSize: 24, fontWeight: 'bold' },
        address: { ...baseStyle, x: 20, y: 140, fontSize: 9 },
        phone: { ...baseStyle, x: 20, y: 160, fontSize: 9 },
        mobile: { ...baseStyle, x: 20, y: 175, fontSize: 9 },
        email: { ...baseStyle, x: 20, y: 190, fontSize: 9 },
        website: { ...baseStyle, x: 20, y: 205, fontSize: 9 },
    };
};

export const extractCardData = async (base64Data: string, mimeType: string): Promise<Partial<CardData>> => {
    if (!process.env.API_KEY) {
        throw new Error("API Key is missing.");
    }

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    const responseSchema = {
        type: Type.OBJECT,
        properties: {
            fullName: { type: Type.STRING },
            title: { type: Type.STRING },
            companyName: { type: Type.STRING },
            email: { type: Type.STRING },
            phone: { type: Type.STRING },
            mobile: { type: Type.STRING },
            address: { type: Type.STRING },
            website: { type: Type.STRING },
        },
        required: ["fullName"],
    };

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
                parts: [
                    { inlineData: { data: base64Data, mimeType: mimeType } },
                    { text: "Extract the business card information. Return JSON." }
                ]
            },
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
            }
        });

        const text = response.text;
        if (!text) throw new Error("No response from Gemini");

        const data = parseJSON(text);
        if (!data) throw new Error("Failed to parse extracted data");
        
        // Inject default layout
        data.layout = createDefaultLayout();

        return data;

    } catch (error) {
        console.error("Gemini Extraction Error:", error);
        throw error;
    }
};