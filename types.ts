export interface ElementStyle {
  x: number;
  y: number;
  fontSize: number;
  fontFamily: 'Noto Sans JP' | 'Noto Serif JP';
  fontWeight: 'normal' | 'bold';
  color: string;
  textAlign: 'left' | 'center' | 'right';
}

export type CardField = 'fullName' | 'title' | 'companyName' | 'email' | 'phone' | 'mobile' | 'address' | 'website';

export interface CardData {
  id: string;
  fullName: string;
  title: string;
  companyName: string;
  email: string;
  phone: string;
  mobile: string;
  address: string;
  website: string;
  logoUrl?: string;
  layout: Record<string, ElementStyle>; // Map field name to style
}

export interface CompanyGroup {
  name: string;
  cards: CardData[];
}

export enum AppState {
  DASHBOARD = 'DASHBOARD',
  UPLOAD = 'UPLOAD',
  EDIT = 'EDIT',
}

export interface UploadStatus {
  isUploading: boolean;
  message: string;
  error?: string;
}