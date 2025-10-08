# 🎙️ Voice Commander

**Your AI-powered voice assistant for productivity** - Control your calendar, contacts, and workspace with natural speech. Say goodbye to clicking through apps—just speak what you need.

[![Live Demo](https://img.shields.io/badge/Live-voicecommander.org-brightgreen.svg)](https://voicecommander.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 🎯 What is Voice Commander?

Voice Commander is a **SaaS platform** that lets you control your digital workspace through natural conversation. Instead of switching between apps, clicking buttons, and filling forms—just speak:

- 🗓️ **"What's on my calendar tomorrow?"**
- ✏️ **"Schedule a meeting with John next Monday at 3 PM"**
- 📧 **"Find Sarah's email address"**
- 🔄 **"Cancel my 2 PM meeting and notify attendees"**

The AI understands context, handles multi-step workflows, and works across all your connected services.

## ✨ Features

### 🎤 **Voice-First Experience**

- Speak naturally—no commands to memorize
- Continuous conversation mode with context awareness
- Sub-1 second response time
- Works in any modern browser (Chrome, Edge, Safari)

### 🤖 **Intelligent AI Assistant**

- Understands follow-up questions ("What about next week?")
- Handles complex multi-step requests
- Learns from conversation history
- Provides natural voice responses

### 🔌 **Connected Services**

- ✅ **Google Calendar** - Full calendar management
- ✅ **Google Contacts** - Search and find contacts
- 🚧 **Slack** (Coming Soon) - Send messages, manage channels
- 🚧 **Email** (Coming Soon) - Read and send emails

### 🔒 **Secure & Private**

- Industry-standard OAuth 2.1 authentication
- Your data never leaves your connected accounts
- Encrypted token storage (AES-256-GCM)
- Full control to disconnect services anytime

---

## 🚀 Getting Started (For Users)

### 1. Visit [voicecommander.org](https://voicecommander.org)

### 2. Sign Up & Connect Your Google Account

Click "Connect Google Calendar" and authorize Voice Commander to access your calendar and contacts.

### 3. Start Speaking

Click the microphone button and say:

- "What meetings do I have today?"
- "Schedule lunch with Sarah tomorrow at 1 PM"
- "Find John's email address"

That's it! No installation, no configuration—just speak and get things done.

---

## 💡 Example Commands

### Calendar Management

```text
✅ "What's on my calendar today?"
✅ "Show me meetings tomorrow between 2 and 5 PM"
✅ "Create a meeting called Sprint Planning tomorrow at 3 PM"
✅ "Update the 3 PM meeting to 4 PM"
✅ "Cancel all meetings tomorrow afternoon"
```

### Contact Search

```text
✅ "Find John Smith's email"
✅ "Search for contacts at acme.com"
✅ "Who is Sarah Johnson?"
```

### Multi-Step Workflows

```text
✅ "Check my calendar tomorrow 3-4 PM, if there are meetings, cancel them"
✅ "Find meetings with Sarah this week and move them to next Monday"
✅ "List all-day events this month"
```

### Context-Aware Follow-ups

```text
You: "What meetings do I have tomorrow?"
AI: "You have 3 meetings tomorrow: Sprint Planning at 9 AM..."

You: "Cancel the 9 AM one"
AI: "Cancelled Sprint Planning meeting at 9 AM tomorrow"

You: "Move the afternoon meeting to Friday"
AI: "Moved Design Review from tomorrow 2 PM to Friday 2 PM"
```

---

## 🏗️ How It Works

```plaintext
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Your Voice     │─────▶│  AI Brain        │─────▶│ Your Apps       │
│  Commands       │      │  (GPT-4)         │      │ - Google Cal    │
│                 │      │                  │      │ - Contacts      │
└─────────────────┘      └──────────────────┘      │ - Slack (Soon)  │
        ▲                         │                 └─────────────────┘
        │                         ▼
        │                ┌──────────────────┐
        └────────────────│  Voice Response  │
                         │  (Text-to-Speech)│
                         └──────────────────┘
```

1. **You speak** - Natural language, no special commands needed
2. **AI understands** - GPT-4 interprets your intent and context
3. **Actions happen** - Executes across your connected services
4. **You hear back** - Natural voice confirmation of what was done

---

## 👨‍💻 For Developers (Self-Hosting & Contributions)

Want to self-host Voice Commander or contribute to the project? See our [Developer Guide](CONTRIBUTING.md) for:

- Local development setup
- Architecture documentation
- API reference
- Contribution guidelines

### Quick Start for Developers

```bash
# Clone repository
git clone https://github.com/yourusername/voice-mcp.git
cd voice-mcp

# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Setup environment (see .env.example files)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# Edit .env files with your credentials

# Start databases
docker-compose up -d

# Run migrations
cd backend && npx prisma migrate deploy

# Start servers
npm run dev  # Backend (Terminal 1)
cd ../frontend && npm run dev  # Frontend (Terminal 2)
```

Visit `http://localhost:3001` to access the local instance.

### Tech Stack

**Backend**: Node.js, TypeScript, Express, Prisma, PostgreSQL, Redis
**Frontend**: Next.js 14, React 18, TailwindCSS
**AI**: OpenAI GPT-4, Web Speech API
**Auth**: OAuth 2.1 PKCE
**Deployment**: Railway (Backend), Vercel (Frontend), Cloudflare (DNS)

---

## 🚀 Production Deployment

### Recommended Architecture

```plaintext
┌─────────────────────────────────────────────────────┐
│  Cloudflare (voicecommander.org)                    │
│  - DNS + CDN + DDoS Protection                      │
└────────────┬────────────────────────────────────────┘
             │
             ├──────────────────┬────────────────────┐
             │                  │                    │
    ┌────────▼────────┐ ┌──────▼─────────┐ ┌────────▼────────┐
    │  Vercel         │ │  Railway       │ │  Railway DB     │
    │  (Frontend)     │ │  (Backend API) │ │  (PostgreSQL)   │
    │  Next.js App    │ │  + Redis       │ │  + Redis        │
    └─────────────────┘ └────────────────┘ └─────────────────┘
```

### Deployment Steps

1. **Backend (Railway)**

   ```bash
   railway up
   railway variables set DATABASE_URL="..." OPENAI_API_KEY="..."
   ```

2. **Frontend (Vercel)**

   ```bash
   vercel --prod
   ```

3. **Domain (Cloudflare)**
   - Point `voicecommander.org` to Vercel
   - Add CNAME for `api.voicecommander.org` → Railway backend

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete production deployment guide.

---

## 🛡️ Security & Privacy

### Data Privacy

- **Zero data storage**: We don't store your calendar events, emails, or contacts
- **OAuth tokens only**: We only store encrypted OAuth tokens to access your services
- **You control access**: Revoke access anytime from your dashboard
- **No tracking**: We don't track or analyze your voice commands

### Security Measures

- ✅ OAuth 2.1 PKCE flow (industry standard)
- ✅ AES-256-GCM token encryption
- ✅ Secure HTTPS-only connections
- ✅ Regular security audits
- ✅ No passwords stored (OAuth only)

---

## 📊 Troubleshooting

### "Voice recognition not working"

- **Check browser**: Use Chrome, Edge, or Safari (Firefox not supported)
- **Check microphone**: Allow microphone access in browser settings
- **Check audio**: Test microphone in system settings

### "Calendar not syncing"

1. Go to Dashboard → Connected Services
2. Click "Disconnect" on Google Calendar
3. Click "Connect" and authorize again

### "Can't find contacts"

Make sure you authorized Google Contacts access when connecting your account. Disconnect and reconnect to add the permission.

### Need Help?

- 📧 Email: [support@voicecommander.org](mailto:support@voicecommander.org)
- 💬 Discord: [Join our community](https://discord.gg/voicecommander)
- 🐛 Bug Reports: [GitHub Issues](https://github.com/yourusername/voice-mcp/issues)

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Code of conduct
- Development setup
- Pull request process
- Coding standards

---

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [OpenAI](https://openai.com/) - GPT-4 API
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [Google Cloud](https://cloud.google.com/) - Calendar & Contacts APIs
- Our amazing [contributors](https://github.com/yourusername/voice-mcp/graphs/contributors)

---

## Built with ❤️ for productivity enthusiasts

[Website](https://voicecommander.org) • [Twitter](https://twitter.com/voicecommander) • [Discord](https://discord.gg/voicecommander)
