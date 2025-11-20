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

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      // Fallback: show a prompt so user can copy manually
      window.prompt('Copy this link', url);
    }
  } catch (err) {
    console.error('Failed to copy share link to clipboard', err);
    // Fallback prompt if clipboard API fails
    window.prompt('Copy this link', url);
  }

  return url;
}
