import { Logo } from "../lib";

const CONTACT = "mail2kp1000@gmail.com";
const UPDATED = "September 28, 2026";

export default function Privacy() {
  return (
    <div className="landing" style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 60px" }}>
      <a href="#/" className="row" style={{ textDecoration: "none", marginBottom: 24 }}><Logo /><strong>Twofold</strong></a>
      <h1>Privacy policy</h1>
      <p className="muted">Last updated {UPDATED}</p>

      <p>Twofold is a personal assistant. To help you, it needs to read some of your information. This page says exactly what, why, who else touches it, and how to delete it. Plain words, no tricks.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account:</strong> your email, name, timezone and settings.</li>
        <li><strong>What you tell Twofold:</strong> chat messages, texts you send to our number, files and photos you attach, memories, decisions, tasks, goals, people and rules.</li>
        <li><strong>Google, only if you connect it:</strong> Gmail messages (to sort mail, find what needs you, and draft replies), the ability to send email you approve, and Google Calendar events (to plan your day and add events you approve).</li>
        <li><strong>Phone number, only if you link one:</strong> to talk with you over iMessage, SMS or WhatsApp.</li>
        <li><strong>Usage:</strong> which days you used Twofold and what each AI step cost, so we can keep the service running and affordable.</li>
      </ul>

      <h2>How we use Google data</h2>
      <p><strong>Twofold's use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</strong></p>
      <ul>
        <li>We use Gmail and Calendar data only to provide the features you see in Twofold: sorting, summaries, reminders, drafts and events.</li>
        <li>We never use Google data for advertising, never sell it, and never use it to build profiles for anyone else.</li>
        <li>People at Twofold do not read your email, except with your permission for a specific support request, for security reasons, or when the law requires it.</li>
        <li>We do not use Google data to train general AI models.</li>
        <li>Nothing is sent from your Gmail or added to your calendar unless you approve it, or you created a rule that allows it.</li>
      </ul>

      <h2>Who else processes your data</h2>
      <p>We share only what each job needs, with these providers acting on our behalf:</p>
      <ul>
        <li><strong>Anthropic</strong> (Claude): writes replies, drafts and plans.</li>
        <li><strong>TypeSafe</strong> (Jev): makes fast yes or no judgments, like "is this email urgent".</li>
        <li><strong>Supabase:</strong> stores your data and runs our servers.</li>
        <li><strong>Twilio and Sendblue:</strong> deliver texts, only if you link a phone.</li>
        <li><strong>Vercel:</strong> hosts the website.</li>
      </ul>
      <p>We do not sell your personal information.</p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Email text is kept as short excerpts and cleared after 30 days.</li>
        <li>Everything else stays until you delete it or delete your account.</li>
        <li>Google access tokens are stored encrypted.</li>
      </ul>

      <h2>Your controls</h2>
      <ul>
        <li>See and delete any memory, decision or person in the app.</li>
        <li>Disconnect Google in Settings. You can also remove access at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.</li>
        <li>Reply STOP to any text to stop alerts, or unlink your number in Settings.</li>
        <li>Delete your account in Settings. This removes your data and revokes Google access.</li>
      </ul>

      <h2>Security</h2>
      <p>Data is encrypted in transit and at rest. Each account can only read its own rows. Email and web content is treated as untrusted data, and the assistant never follows instructions hidden inside it.</p>

      <h2>Children</h2>
      <p>Twofold is not for anyone under 18.</p>

      <h2>Contact</h2>
      <p>Questions or deletion requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
    </div>
  );
}
