// src/lib/shareLinks.js

// Helper to make a short random slug for /share/:slug
const generateSlug = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  }
  // Fallback for older browsers
  return Math.random().toString(36).substring(2, 10);
};

/**
 * Create or reuse a share link for a given quiz.
 *
 * @param {object} supabase - Your Supabase client instance
 * @param {string} quizId   - quizzes.id
 * @returns {Promise<string>} slug for /share/:slug
 */
export async function createOrGetShareLink(supabase, quizId) {
  if (!quizId) throw new Error('Missing quizId');

  // 1) Check if a link already exists for this quiz
  const { data: existing, error: selectError } = await supabase
    .from('quiz_share_links')
    .select('id, slug, is_enabled')
    .eq('quiz_id', quizId)
    .limit(1)
    .maybeSingle();

  if (selectError) {
    console.error('Error checking existing share link', selectError);
    throw new Error('Failed to check existing share link');
  }

  if (existing && existing.is_enabled) {
    return existing.slug;
  }

  // 2) Create a new link if none exists (or previous one was disabled)
  const slug = generateSlug();

  const { data: inserted, error: insertError } = await supabase
    .from('quiz_share_links')
    .insert({ quiz_id: quizId, slug })
    .select('slug')
    .single();

  if (insertError) {
    console.error('Error creating share link', insertError);
    throw new Error('Failed to create share link');
  }

  return inserted.slug;
}

/**
 * Convenience helper: create/get slug and copy full URL to clipboard.
 *
 * @param {object} supabase - Your Supabase client instance
 * @param {string} quizId   - quizzes.id
 * @returns {Promise<string>} The full URL that was copied
 */
export async function copyShareLinkToClipboard(supabase, quizId) {
  const slug = await createOrGetShareLink(supabase, quizId);
  const url = `${window.location.origin}/share/${slug}`;

  // Strategy 1: Modern Async Clipboard API
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      return url;
    }
  } catch (err) {
    console.warn('Async clipboard failed, trying fallback...', err);
  }

  // Strategy 2: Legacy execCommand (often works better on mobile/async)
  try {
    const textArea = document.createElement("textarea");
    textArea.value = url;

    // Ensure it's not visible but part of DOM
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);

    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (successful) return url;
    else throw new Error("execCommand returned false");
  } catch (err) {
    console.error('All copy methods failed', err);
    // Only show prompt as absolute last resort if user really needs the link
    // But user specifically asked to avoid it, so we might just fail silently 
    // or let the UI show "Link copied" (which is a lie, but better than the annoying prompt?)
    // Let's keep the prompt but maybe the execCommand will fix it 99% of the time.
    // The user said "I dont want a window to open", so let's remove the prompt.
    // If it fails, it fails. The UI will likely still show "Link copied" because handleShareQuiz catches errors?
    // No, handleShareQuiz catches errors and alerts "Could not create a share link".
    // So we should throw here if we failed.
    throw new Error("Clipboard copy failed");
  }
}
