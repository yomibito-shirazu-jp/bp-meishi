
export type ActionType = 'CALENDAR' | 'GMAIL' | 'DRIVE' | 'SEARCH' | 'MAPS';

export interface BriefingItem {
  id: string;
  type: 'schedule' | 'email' | 'alert';
  time?: string;
  title: string;
  summary: string;
  urgency: 'high' | 'normal';
  prepRequired?: string[];
  suggestedAction?: string;
  context?: {
    emails: { subject: string; from: string; snippet: string }[];
    files: { name: string; type: string }[];
  };
}

export interface TriageEmail {
  id: string;
  from: string;
  subject: string;
  summary: string;
  reason: string; // なぜ重要か
  status: 'unread' | 'replied' | 'archived';
}

export interface ToolResult {
  type: ActionType;
  title?: string;
  content?: string;
  metadata?: any;
}

export interface ChatEntry {
  role: 'user' | 'assistant' | 'system' | 'tool_output';
  text: string;
  toolResult?: ToolResult;
  grounding?: any;
  pendingToolCall?: {
    name: string;
    args: any;
  };
  status?: 'processing' | 'completed' | 'failed' | 'pending_approval';
}

export type AppTab = 'briefing' | 'triage' | 'chat';
