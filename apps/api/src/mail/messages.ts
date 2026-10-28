import { type MailJob, PASSWORD_RESET_TTL_MINUTES, type ProjectRole } from '@galley/shared';

/**
 * Notification texts (SPEC §3.4, §3.9). The server does not know the reader's
 * interface language, so every message carries French then English. Plain
 * text only: nothing a user typed can turn into markup or a disguised link.
 */

const ROLES: Record<ProjectRole, [fr: string, en: string]> = {
  owner: ['propriétaire', 'owner'],
  editor: ['éditeur', 'editor'],
  reviewer: ['relecteur', 'reviewer'],
  reader: ['lecteur', 'reader'],
};

/** Longest comment excerpt quoted in a mention. */
const EXCERPT_LENGTH = 500;

/** One line of user text: no line breaks that could fake a paragraph of the message. */
function inline(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function bilingual(to: string, subject: string, fr: string[], en: string[]): MailJob {
  return { to, subject, text: [...fr, '', '—', '', ...en, ''].join('\n') };
}

/** Message carrying a password reset link. */
export function passwordResetMail(input: {
  to: string;
  displayName: string;
  link: string;
}): MailJob {
  const name = inline(input.displayName, 100);
  const minutes = String(PASSWORD_RESET_TTL_MINUTES);
  return bilingual(
    input.to,
    'Galley : réinitialisation du mot de passe / password reset',
    [
      `Bonjour ${name},`,
      '',
      'Pour choisir un nouveau mot de passe, ouvrez ce lien :',
      input.link,
      '',
      `Il reste valable ${minutes} minutes et ne sert qu'une fois. Si vous n'avez rien demandé, ignorez ce message : votre mot de passe ne change pas.`,
    ],
    [
      `Hello ${name},`,
      '',
      'To choose a new password, open this link:',
      input.link,
      '',
      `It is valid for ${minutes} minutes and works once. If you did not ask for it, ignore this message: your password stays the same.`,
    ],
  );
}

/** Message telling someone they are invited to a project. */
export function projectInviteMail(input: {
  to: string;
  inviter: string;
  project: string;
  role: ProjectRole;
  link: string;
}): MailJob {
  const inviter = inline(input.inviter, 100);
  const project = inline(input.project);
  const [roleFr, roleEn] = ROLES[input.role];
  return bilingual(
    input.to,
    `Galley : invitation au projet « ${project} »`,
    [
      `${inviter} vous invite à rejoindre le projet « ${project} » en tant que ${roleFr}.`,
      '',
      'Acceptez ou refusez l’invitation depuis votre tableau de bord :',
      input.link,
    ],
    [
      `${inviter} invites you to the project “${project}” as ${roleEn}.`,
      '',
      'Accept or decline the invitation from your dashboard:',
      input.link,
    ],
  );
}

/** Message telling someone a comment mentions them. */
export function mentionMail(input: {
  to: string;
  author: string;
  project: string;
  comment: string;
  link: string;
  settings: string;
}): MailJob {
  const author = inline(input.author, 100);
  const project = inline(input.project);
  const excerpt = inline(input.comment, EXCERPT_LENGTH);
  return bilingual(
    input.to,
    `Galley : ${author} vous a mentionné dans « ${project} »`,
    [
      `${author} vous a mentionné dans un commentaire du projet « ${project} » :`,
      '',
      `  ${excerpt}`,
      '',
      input.link,
      '',
      `Pour ne plus recevoir ces messages : ${input.settings}`,
    ],
    [
      `${author} mentioned you in a comment on the project “${project}”:`,
      '',
      `  ${excerpt}`,
      '',
      input.link,
      '',
      `To stop these messages: ${input.settings}`,
    ],
  );
}
