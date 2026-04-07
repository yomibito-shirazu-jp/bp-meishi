# Document AI Setup Guide

## Environment Variables

Add the following environment variables to your `.env.local` file:

```bash
# Google Cloud Document AI Configuration
VITE_GOOGLE_PROJECT_ID=your_google_project_id
VITE_DOCUMENT_AI_LOCATION=us
VITE_DOCUMENT_AI_PROCESSOR_ID=your_project_id/locations/us/processors/business-card-processor

# Existing Google AI Configuration (required)
VITE_GOOGLE_AI_KEY=your_google_ai_api_key
```

## Google Cloud Setup

1. **Create a Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one

2. **Enable Document AI API**
   - In your project, enable the Document AI API
   - Go to APIs & Services > Library > Search for "Document AI"

3. **Create a Document AI Processor**
   - Go to Document AI in the Google Cloud Console
   - Create a new processor
   - Choose "Business Card Processor" or "Form Parser"
   - Note the processor ID (format: `projects/PROJECT_ID/locations/LOCATION/processors/PROCESSOR_ID`)

4. **Set up Authentication**
   - Create a service account with Document AI permissions
   - Download the JSON key file
   - Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the key file path
   - OR use default authentication with `gcloud auth application-default login`

## Backend Setup

1. Install the required dependencies:
```bash
cd backend
pip install -r requirements.txt
```

2. The backend now includes Document AI endpoints:
   - `POST /documentai-analyze` - Analyze PDF with Document AI
   - `POST /documentai-business-card` - Extract business card info from PDF

## Frontend Integration

The frontend now supports:
- PDF upload and processing with Document AI
- Hybrid processing (Image OCR + PDF Document AI)
- Business card information extraction

## Usage

1. **PDF Processing**:
   - Upload a PDF file containing business cards
   - The system will use Document AI to extract structured information
   - Results include company, name, email, phone, etc.

2. **Hybrid Processing**:
   - If both image and PDF are provided, Document AI takes priority
   - Falls back to image OCR if Document AI fails

3. **Configuration**:
   - Use the Settings UI to configure Document AI parameters
   - Processor ID and location can be customized

## API Endpoints

### Analyze PDF
```typescript
POST /documentai-analyze
{
  "pdf_b64": "base64_encoded_pdf",
  "processor_id": "optional_custom_processor_id"
}
```

### Extract Business Card
```typescript
POST /documentai-business-card
Content-Type: multipart/form-data
file: [PDF file]
```

## Error Handling

- Missing `VITE_GOOGLE_PROJECT_ID` will cause Document AI to fail
- Invalid processor ID will result in API errors
- Authentication failures will be logged with detailed messages
- The system falls back to image OCR if Document AI is unavailable
