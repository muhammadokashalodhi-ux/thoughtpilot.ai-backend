// src/utils/emailTemplates.js
// Single shared email template system — ALL emails use buildEmail()
// This ensures consistent branding across welcome, test, post notifications, weekly digest

const APP_URL = 'https://app.thoughtpilotai.com';
const SITE_URL = 'https://thoughtpilotai.com';

// ─── Master template wrapper ──────────────────────────────────────────────────
// Every email uses this outer shell — dark navy, gradient header, consistent footer
function buildEmail({ title, subtitle = 'Your LinkedIn Co-Pilot', preheader = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title}</title>
${preheader ? `<span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>` : ''}
</head>
<body style="margin:0;padding:0;background:#060816;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#060816;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#1e3a5f 0%,#2d1b4e 100%);padding:32px 40px 28px;text-align:center;">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:10px;font-size:20px;margin-bottom:14px;">🔗</div>
          <div style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;margin-bottom:4px;">${title}</div>
          <div style="color:rgba(255,255,255,0.55);font-size:12px;letter-spacing:0.05em;text-transform:uppercase;">${subtitle}</div>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px 40px;">
          ${body}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:16px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
          <p style="margin:0 0 8px;font-size:12px;color:#475569;">
            <a href="${APP_URL}/dashboard" style="color:#3b82f6;text-decoration:none;">Dashboard</a>
            &nbsp;·&nbsp;
            <a href="${APP_URL}/dashboard/settings" style="color:#3b82f6;text-decoration:none;">Settings</a>
            &nbsp;·&nbsp;
            <a href="${SITE_URL}" style="color:#3b82f6;text-decoration:none;">thoughtpilotai.com</a>
          </p>
          <p style="margin:0;font-size:11px;color:#334155;">© ${new Date().getFullYear()} ThoughtPilot AI · noreply@thoughtpilotai.com</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function greeting(name) {
  return `<p style="color:#cbd5e1;font-size:16px;margin:0 0 20px;">Hi <strong style="color:#f1f5f9;">${name || 'there'}</strong> 👋</p>`;
}

function para(text) {
  return `<p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 16px;">${text}</p>`;
}

function ctaButton(text, url, secondary = false) {
  return secondary
    ? `<a href="${url}" style="display:inline-block;background:#1e2130;border:1px solid #2d3348;color:#94a3b8;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px;">${text}</a>`
    : `<a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:-0.2px;">${text}</a>`;
}

function ctaRow(...buttons) {
  return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:24px 0;">${buttons.join('')}</div>`;
}

function infoBox(items) {
  const rows = items.map(({ icon, label, value }) => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <span style="font-size:14px;">${icon}</span>
        <span style="color:#64748b;font-size:13px;margin-left:8px;">${label}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);text-align:right;">
        <span style="color:#e2e8f0;font-size:13px;font-weight:600;">${value}</span>
      </td>
    </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2130;border-radius:8px;overflow:hidden;margin:0 0 20px;">${rows}</table>`;
}

function alertBox(text, type = 'info') {
  const colors = {
    info:    { bg: '#1e2a3a', border: '#2563eb', text: '#93c5fd' },
    success: { bg: '#0d1f15', border: '#16a34a', text: '#86efac' },
    warning: { bg: '#1f1a0d', border: '#d97706', text: '#fcd34d' },
  };
  const c = colors[type] || colors.info;
  return `<div style="background:${c.bg};border-left:3px solid ${c.border};border-radius:6px;padding:14px 16px;margin:0 0 20px;">
    <p style="color:${c.text};margin:0;font-size:13px;line-height:1.6;">${text}</p>
  </div>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;"/>`;
}

function smallText(text) {
  return `<p style="color:#475569;font-size:12px;line-height:1.6;margin:0 0 8px;">${text}</p>`;
}

// ─── 1. WELCOME EMAIL ─────────────────────────────────────────────────────────
function buildWelcomeEmail({ firstName, email, onboardingComplete }) {
  const profileIncompleteAlert = !onboardingComplete
    ? alertBox('⚠️ <strong>Your profile is incomplete.</strong> Complete your onboarding to get posts that actually sound like you — takes 5 minutes.', 'warning')
    : '';

  const body = `
    ${greeting(firstName)}
    ${para('Welcome to ThoughtPilot AI — your LinkedIn co-pilot for SCM professionals. You\'re in.')}
    ${profileIncompleteAlert}

    <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 16px;">Here\'s what to do next to get the most out of it:</p>

    ${infoBox([
      { icon: '👤', label: 'Step 1', value: 'Complete your career profile' },
      { icon: '🔔', label: 'Step 2', value: 'Set up notifications & post time' },
      { icon: '📅', label: 'Step 3', value: 'Generate your first week\'s calendar' },
      { icon: '✍️', label: 'Step 4', value: 'Generate your first post' },
    ])}

    ${ctaRow(
      ctaButton('Start setup →', `${APP_URL}/dashboard`),
      ctaButton('View guide', `${APP_URL}/dashboard`, true)
    )}

    ${divider()}
    ${smallText('You signed up with <strong style="color:#64748b;">' + email + '</strong>. If this wasn\'t you, you can ignore this email.')}
  `;

  return buildEmail({
    title: 'Welcome to ThoughtPilot AI',
    subtitle: 'Your LinkedIn Co-Pilot',
    preheader: 'Your account is ready — here\'s what to do next.',
    body,
  });
}

// ─── 2. TEST EMAIL (notification connected) ───────────────────────────────────
function buildTestEmail({ firstName, recipientEmail }) {
  const body = `
    ${greeting(firstName)}
    ${para('Your email notifications are connected and working. You\'ll receive alerts at <strong style="color:#e2e8f0;">' + recipientEmail + '</strong>.')}

    ${infoBox([
      { icon: '✅', label: 'Post ready', value: 'When your daily post is auto-generated' },
      { icon: '📅', label: 'Weekly digest', value: 'Every Sunday with next week\'s plan' },
      { icon: '🔔', label: 'Calendar reset', value: 'When your content calendar is refreshed' },
    ])}

    ${ctaRow(ctaButton('Go to dashboard →', `${APP_URL}/dashboard`))}
    ${smallText('Manage your notification preferences in <a href="${APP_URL}/dashboard/settings" style="color:#3b82f6;">Settings</a>.')}
  `;

  return buildEmail({
    title: '✅ Email notifications connected',
    subtitle: 'ThoughtPilot AI',
    preheader: 'Your email notifications are working correctly.',
    body,
  });
}

// ─── 3. DAILY POST READY ─────────────────────────────────────────────────────
function buildPostReadyEmail({ firstName, dayName, topic, bodyPreview, personalExperience }) {
  const modeBadge = personalExperience
    ? '<span style="background:#0d1f15;color:#86efac;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid #16a34a;">Personal experience ON</span>'
    : '<span style="background:#1e2a3a;color:#93c5fd;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid #2563eb;">General thought leadership</span>';

  const body = `
    ${greeting(firstName)}
    ${para(`Your <strong style="color:#e2e8f0;">${dayName}</strong> post has been auto-generated and is waiting for your approval.`)}

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2130;border-radius:8px;overflow:hidden;margin:0 0 20px;">
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.05);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Topic</span>
            ${modeBadge}
          </div>
          <p style="color:#e2e8f0;font-size:15px;font-weight:600;margin:0;">${topic}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <span style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:8px;">Preview</span>
          <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0;font-style:italic;">"${bodyPreview}…"</p>
        </td>
      </tr>
    </table>

    ${ctaRow(
      ctaButton('Review & Approve →', `${APP_URL}/dashboard/queue`),
      ctaButton('View Calendar', `${APP_URL}/dashboard/calendar`, true)
    )}
    ${smallText('Manage notification preferences → <a href="' + APP_URL + '/dashboard/settings" style="color:#3b82f6;">Settings</a>')}
  `;

  return buildEmail({
    title: '✅ Post ready to review',
    subtitle: `${dayName} · ThoughtPilot AI`,
    preheader: `Your ${dayName} LinkedIn post is ready — tap to approve.`,
    body,
  });
}

// ─── 4. WEEKLY DIGEST ────────────────────────────────────────────────────────
function buildWeeklyDigestEmail({ firstName, publishedCount, zeroActivity, lowActivity, nextWeekDays }) {
  const activityAlert = zeroActivity
    ? alertBox('💡 <strong>You haven\'t generated any posts in 3+ days.</strong> Consistency is what builds LinkedIn authority — jump back in.', 'warning')
    : lowActivity
    ? alertBox(`⚠️ <strong>Only ${publishedCount} post${publishedCount === 1 ? '' : 's'} this week.</strong> Aim for at least 3 to stay visible on LinkedIn.`, 'warning')
    : alertBox(`✅ <strong>Great week!</strong> You published ${publishedCount} post${publishedCount === 1 ? '' : 's'} this week. Keep it up!`, 'success');

  const calRows = nextWeekDays.length
    ? nextWeekDays.map(d => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);color:#64748b;font-size:13px;white-space:nowrap;">${d.day_name}</td>
        <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);color:#e2e8f0;font-size:13px;">${d.topic || d.theme || '<em style="color:#334155;">Rest day</em>'}</td>
        <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);">
          ${d.topic ? `<span style="background:#1e3a5f;color:#60a5fa;font-size:11px;padding:2px 8px;border-radius:4px;">${d.post_type || 'post'}</span>` : ''}
        </td>
      </tr>`).join('')
    : `<tr><td colspan="3" style="padding:20px;color:#334155;text-align:center;font-size:13px;">No calendar for next week yet.</td></tr>`;

  const body = `
    ${greeting(firstName)}
    ${activityAlert}

    ${alertBox('⚙️ <strong>Action needed:</strong> Review your calendar and set the <strong>Personal Experience</strong> toggle ON/OFF for each day before your scheduled post time.', 'info')}

    <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 10px;">Next week\'s plan</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2130;border-radius:8px;overflow:hidden;margin:0 0 24px;">
      <tr style="background:#161b2e;">
        <th style="padding:10px 16px;color:#475569;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Day</th>
        <th style="padding:10px 16px;color:#475569;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Topic</th>
        <th style="padding:10px 16px;color:#475569;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Type</th>
      </tr>
      ${calRows}
    </table>

    ${ctaRow(
      ctaButton('Review Calendar →', `${APP_URL}/dashboard/calendar`),
      ctaButton('Approval Queue', `${APP_URL}/dashboard/queue`, true)
    )}
    ${smallText('Manage notification preferences → <a href="' + APP_URL + '/dashboard/settings" style="color:#3b82f6;">Settings</a>')}
  `;

  return buildEmail({
    title: '📋 Weekly Digest',
    subtitle: 'ThoughtPilot AI · LinkedIn Co-Pilot',
    preheader: 'Your next week\'s LinkedIn plan is ready for review.',
    body,
  });
}

// ─── 5. PASSWORD RESET ────────────────────────────────────────────────────────
function buildPasswordResetEmail({ firstName, resetLink, ttlMinutes }) {
  const body = `
    ${greeting(firstName)}
    ${para('We received a request to reset your password. Click the button below — this link expires in <strong style="color:#e2e8f0;">' + ttlMinutes + ' minutes</strong>.')}

    ${ctaRow(ctaButton('Reset Password →', resetLink))}

    ${divider()}
    ${smallText('Or copy this link into your browser:')}
    <p style="background:#0f172a;border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:10px 14px;font-size:11px;color:#475569;word-break:break-all;margin:0 0 16px;">${resetLink}</p>
    ${smallText('If you didn\'t request this, you can safely ignore this email — your password won\'t change.')}
  `;

  return buildEmail({
    title: '🔑 Reset your password',
    subtitle: 'ThoughtPilot AI',
    preheader: 'Reset link inside — expires in ' + ttlMinutes + ' minutes.',
    body,
  });
}

// ─── 6. PROFILE INCOMPLETE NUDGE ─────────────────────────────────────────────
function buildProfileIncompleteEmail({ firstName, missingItems }) {
  const items = missingItems.map(item =>
    `<li style="color:#94a3b8;font-size:13px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">${item}</li>`
  ).join('');

  const body = `
    ${greeting(firstName)}
    ${para('Your ThoughtPilot profile is missing some key information. The AI uses your profile to write posts that sound like you — without it, posts will be generic.')}

    ${alertBox('⚠️ <strong>Incomplete profile = generic posts.</strong> Complete these items to unlock your full voice.', 'warning')}

    <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 10px;">What\'s missing</p>
    <ul style="background:#1e2130;border-radius:8px;padding:8px 16px 8px 36px;margin:0 0 24px;list-style:disc;">
      ${items}
    </ul>

    ${ctaRow(ctaButton('Complete my profile →', `${APP_URL}/dashboard/profile`))}
    ${smallText('Takes about 5 minutes. You only need to do this once.')}
  `;

  return buildEmail({
    title: '⚠️ Complete your profile',
    subtitle: 'ThoughtPilot AI',
    preheader: 'Your profile is incomplete — posts will be generic until you fix this.',
    body,
  });
}

// ─── 7. ONBOARDING INCOMPLETE REMINDER ───────────────────────────────────────
function buildOnboardingReminderEmail({ firstName, email }) {
  const body = `
    ${greeting(firstName)}
    ${para('You created your ThoughtPilot AI account but did not finish setting it up yet. It takes about 5 minutes — and it is what makes every post the AI writes actually sound like you.')}

    ${alertBox('⚠️ <strong>Without completing onboarding</strong>, the AI has no information about your career, voice, or industry — posts will be generic and unhelpful.', 'warning')}

    ${infoBox([
      { icon: '👤', label: 'Step 1', value: 'Your role, sectors & experience' },
      { icon: '🎙️', label: 'Step 2', value: 'Your voice tone & writing style' },
      { icon: '🏢', label: 'Step 3', value: 'Companies, achievements & credentials' },
      { icon: '🎯', label: 'Step 4', value: 'Content pillars — your LinkedIn themes' },
    ])}

    ${ctaRow(ctaButton('Complete my setup →', 'https://app.thoughtpilotai.com/onboarding'))}

    ${divider()}
    ${smallText('You signed up with <strong style="color:#64748b;">' + email + '</strong>. If you did not create this account, you can ignore this email.')}
  `;

  return buildEmail({
    title: 'Your ThoughtPilot setup is incomplete',
    subtitle: 'ThoughtPilot AI',
    preheader: 'You are almost there — 5 minutes to finish setup and start generating posts.',
    body,
  });
}

// ─── 8. ONBOARDING SECOND REMINDER ───────────────────────────────────────────
function buildOnboardingSecondReminderEmail({ firstName, email }) {
  const body = `
    ${greeting(firstName)}
    ${para('It has been a couple of days since you signed up for ThoughtPilot AI — and your profile is still empty. Here is what you are missing out on right now:')}

    ${infoBox([
      { icon: '✍️', label: 'You could have', value: 'Generated your first LinkedIn post' },
      { icon: '📅', label: 'You could have', value: 'Planned your whole week of content' },
      { icon: '📡', label: 'You could have', value: 'Spotted trending topics in your sector' },
      { icon: '🎯', label: 'You could have', value: 'Analysed your CV against a job description' },
    ])}

    ${alertBox('🔒 <strong>None of this works without your profile.</strong> The AI needs to know your role, your experience, and your voice to write posts that actually sound like you — not a generic LinkedIn template.', 'warning')}

    <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 16px;">It takes 5 minutes. You only do it once. After that the app runs on autopilot — generating posts, sending you reminders, and building your LinkedIn presence while you focus on your actual job.</p>

    ${ctaRow(ctaButton('Complete my profile now →', 'https://app.thoughtpilotai.com/onboarding'))}

    ${divider()}
    ${smallText('This is the last reminder we will send. If you are no longer interested, simply ignore this email — your account will remain active.')}
    ${smallText('Signed up with <strong style="color:#64748b;">' + email + '</strong>')}
  `;

  return buildEmail({
    title: 'You are missing out — here is what is waiting for you',
    subtitle: 'ThoughtPilot AI',
    preheader: 'Your LinkedIn co-pilot is ready — your profile is not. Fix it in 5 minutes.',
    body,
  });
}

module.exports = {
  buildEmail,
  buildWelcomeEmail,
  buildTestEmail,
  buildPostReadyEmail,
  buildWeeklyDigestEmail,
  buildPasswordResetEmail,
  buildProfileIncompleteEmail,
  buildOnboardingReminderEmail,
  buildOnboardingSecondReminderEmail,
};
