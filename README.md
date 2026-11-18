# FMIC Backend: Financial Memory Layer for Informal Commerce

A production-grade, voice-first AI financial memory system designed for informal retail businesses (e.g., in Nigeria). It helps shop owners capture credit transactions instantly using voice, prevent disputes, and maintain trusted, immutable financial records.

## 🚀 Key Features

- **Voice-First Workflow**: Seamlessly extract transaction data from unstructured speech.
- **Immutable Transaction Engine**: Append-only records with atomic balance updates and idempotency.
- **Versioned Pricing**: Historical price tracking for every product to resolve disputes.
- **Integrity & Evidence**: SHA-256 hashing for tamper-resistance and detailed audit logs.
- **Real-Time Feedback**: WebSocket updates for instant confirmation of voice captures.
- **Offline Resilience**: Idempotent sync for batch-uploading transactions captured offline.

## 🛠 Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) (Node.js & TypeScript)
- **Database**: [MongoDB](https://www.mongodb.com/) with [Mongoose](https://mongoosejs.com/)
- **API Documentation**: [Swagger/OpenAPI](https://swagger.io/)
- **Security**: Helmet, Rate Limiting, JWT (Access/Refresh), SHA-256 Hashing
- **Real-time**: Socket.io

## 📋 Prerequisites

- Node.js (v18+)
- MongoDB (Local or Atlas)

## ⚙️ Setup & Installation

1. **Clone the repository**
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure Environment Variables**:
   Create a `.env` file in the root directory (see [Environment Variables](#-environment-variables) below).
4. **Seed Initial Data**:
   ```bash
   npm run seed
   ```
5. **Start the server**:
   ```bash
   # development
   npm run start:dev
   ```

## 📖 API Documentation

Once the server is running, visit:
`http://localhost:3000/api/docs` to view the interactive Swagger documentation.

## 🧪 Testing

```bash
# Run unit tests
npm run test
```

## 🔐 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/fmic-db` |
| `JWT_SECRET` | Secret key for JWT signing | `super-secret-key` |
| `JWT_EXPIRES_IN` | JWT expiration time | `1h` |
| `MOCK_AI` | Toggle mock AI extraction | `true` |
| `GEMINI_API_KEY` | Free key from Google AI Studio. When set, voice notes go straight to Gemini (audio in, transactions out). When unset, the old HF ASR + Groq pipeline is used. | — |
| `GEMINI_MODEL` | Gemini model to use | `gemini-2.5-flash` |
| `GEMINI_TIMEOUT_MS` | Timeout for a Gemini call before falling back | `45000` |
| `GROQ_API_KEY` | Groq key for the fallback LLM | — |
| `HF_SPACE_URL` | Hugging Face Space with `/asr/yoruba` and `/asr/english` (fallback only) | — |
| `REDIS_URL` | Optional. Caches LLM parses. Leave unset on free hosting. | — |

## 🏗 Architecture

The system follows a modular, layered architecture:
- **Modules**: Auth, Customers, Products, Transactions, Voice, Integrity, Realtime.
- **Common**: Shared guards, decorators, and utilities.
- **Schemas**: Mongoose models for data persistence.
- **DTOs**: Data Transfer Objects for validation.

---
Designed for simplicity, reliability, and trust in informal commerce.
