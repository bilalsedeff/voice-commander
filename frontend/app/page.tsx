import Link from "next/link";
import { Mic, Zap, Link as LinkIcon, Shield, Sparkles, Calendar, MessageSquare, FileText } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Navigation */}
      <nav className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Mic className="w-8 h-8 text-indigo-600" />
            <span className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              Voice Commander
            </span>
          </div>
          <div className="flex gap-4">
            <Link
              href="/login"
              className="px-6 py-2 text-gray-700 hover:text-indigo-600 transition-colors font-medium"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all hover:scale-105 font-medium"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <div className="max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-100 text-indigo-700 rounded-full text-sm font-medium mb-8 animate-bounce-slow">
            <Sparkles className="w-4 h-4" />
            <span>100% Free • No Credit Card Required</span>
          </div>

          {/* Main Heading */}
          <h1 className="text-6xl md:text-7xl font-bold text-gray-900 mb-6 leading-tight">
            Control All Your Apps
            <br />
            <span className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
              With Your Voice
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-xl md:text-2xl text-gray-600 mb-12 max-w-3xl mx-auto">
            Schedule meetings, send messages, create documents - all through natural voice commands.
            No coding required.
          </p>

          {/* CTA Buttons */}
          <div className="flex justify-center gap-4 mb-16">
            <Link
              href="/dashboard"
              className="px-8 py-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all hover:scale-105 font-semibold text-lg shadow-lg shadow-indigo-200"
            >
              Try It Free →
            </Link>
            <a
              href="#how-it-works"
              className="px-8 py-4 bg-white text-indigo-600 rounded-xl border-2 border-indigo-600 hover:bg-indigo-50 transition-all font-semibold text-lg"
            >
              See How It Works
            </a>
          </div>

          {/* Demo Command Examples */}
          <div className="bg-white/60 backdrop-blur-sm rounded-2xl p-8 border border-gray-200 shadow-xl">
            <div className="flex items-center gap-2 mb-4">
              <Mic className="w-5 h-5 text-indigo-600" />
              <span className="text-sm font-semibold text-gray-600">Try saying:</span>
            </div>
            <div className="space-y-3 text-left">
              <CommandExample text="Schedule a meeting tomorrow at 3 PM with John and Sarah" />
              <CommandExample text="Send a Slack message to the team about project update" />
              <CommandExample text="Create a new Notion page titled 'Weekly Report'" />
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            Why Voice Commander?
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            The fastest way to control your productivity tools
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          <FeatureCard
            icon={<Mic className="w-12 h-12 text-indigo-600" />}
            title="Voice First"
            description="Speak naturally - our AI understands your commands and executes them instantly"
          />
          <FeatureCard
            icon={<LinkIcon className="w-12 h-12 text-purple-600" />}
            title="Connect Everything"
            description="Google Calendar, Slack, Notion, GitHub, and more - all in one place"
          />
          <FeatureCard
            icon={<Zap className="w-12 h-12 text-pink-600" />}
            title="Lightning Fast"
            description="Execute complex workflows in milliseconds with multi-command chaining"
          />
          <FeatureCard
            icon={<Shield className="w-12 h-12 text-indigo-600" />}
            title="Secure & Private"
            description="Your data stays encrypted. We never store your conversations or credentials"
          />
          <FeatureCard
            icon={<Sparkles className="w-12 h-12 text-purple-600" />}
            title="Smart AI"
            description="Advanced natural language understanding - no need to memorize commands"
          />
          <FeatureCard
            icon={<Zap className="w-12 h-12 text-pink-600" />}
            title="100% Free"
            description="No hidden costs. No credit card. Just connect and start commanding"
          />
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="container mx-auto px-4 py-20 bg-white/60 backdrop-blur-sm rounded-3xl">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            How It Works
          </h2>
          <p className="text-xl text-gray-600">
            Get started in 3 simple steps
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          <StepCard
            number="1"
            title="Connect Your Services"
            description="Link your Google Calendar, Slack, Notion, and other apps with one click"
          />
          <StepCard
            number="2"
            title="Speak Your Command"
            description="Click the microphone and say what you want to do in natural language"
          />
          <StepCard
            number="3"
            title="Watch It Happen"
            description="Voice Commander executes your command instantly across all connected apps"
          />
        </div>
      </section>

      {/* Supported Services */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            Supported Services
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-4">
            Connect with your favorite productivity tools
          </p>
          <p className="text-sm text-gray-500">More integrations coming soon...</p>
        </div>

        <div className="grid md:grid-cols-4 gap-6 max-w-5xl mx-auto">
          <ServiceCard
            icon={<Calendar className="w-8 h-8" />}
            name="Google Calendar"
            description="Schedule meetings"
            color="bg-blue-500"
          />
          <ServiceCard
            icon={<MessageSquare className="w-8 h-8" />}
            name="Slack"
            description="Send messages"
            color="bg-purple-500"
          />
          <ServiceCard
            icon={<FileText className="w-8 h-8" />}
            name="Notion"
            description="Create pages"
            color="bg-gray-900"
          />
          <ServiceCard
            icon={<LinkIcon className="w-8 h-8" />}
            name="GitHub"
            description="Manage repos"
            color="bg-gray-700"
          />
        </div>
      </section>

      {/* CTA Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-3xl p-16 text-center text-white shadow-2xl">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Ready to Command Your Apps?
          </h2>
          <p className="text-xl mb-8 opacity-90 max-w-2xl mx-auto">
            Join thousands of users who are saving hours every week with voice commands
          </p>
          <Link
            href="/dashboard"
            className="inline-block px-10 py-5 bg-white text-indigo-600 rounded-xl hover:bg-gray-100 transition-all hover:scale-105 font-bold text-lg shadow-lg"
          >
            Start for Free - No Credit Card Required
          </Link>
          <p className="mt-4 text-sm opacity-75">
            Takes less than 2 minutes to set up
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm mt-20">
        <div className="container mx-auto px-4 py-8 text-center text-gray-600">
          <p className="mb-2">© 2025 Voice Commander. Built with ❤️ for productivity.</p>
          <p className="text-sm">
            Open source • Privacy first • No credit card required
          </p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="bg-white p-8 rounded-2xl shadow-lg hover:shadow-xl transition-all hover:-translate-y-1 border border-gray-100">
      <div className="mb-4">{icon}</div>
      <h3 className="text-xl font-bold mb-3 text-gray-900">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  );
}

function StepCard({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="text-center">
      <div className="w-16 h-16 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-full flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4 shadow-lg">
        {number}
      </div>
      <h3 className="text-xl font-bold mb-2 text-gray-900">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  );
}

function ServiceCard({ icon, name, description, color }: { icon: React.ReactNode; name: string; description: string; color: string }) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-md hover:shadow-lg transition-all hover:-translate-y-1 border border-gray-100">
      <div className={`${color} w-12 h-12 rounded-lg flex items-center justify-center text-white mb-4`}>
        {icon}
      </div>
      <h3 className="font-bold text-gray-900 mb-1">{name}</h3>
      <p className="text-sm text-gray-600">{description}</p>
    </div>
  );
}

function CommandExample({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-indigo-50 transition-colors">
      <div className="w-2 h-2 bg-indigo-600 rounded-full mt-2 flex-shrink-0"></div>
      <p className="text-gray-700 font-medium">&quot;{text}&quot;</p>
    </div>
  );
}
