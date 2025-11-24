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
  // 1. Prepare the promise that resolves to the URL
  const urlPromise = createOrGetShareLink(supabase, quizId).then((slug) => {
    return `${window.location.origin}/share/${slug}`;
  });

  // Strategy 1: Safari / Modern Async Clipboard (ClipboardItem + Promise)
  // This MUST be called synchronously, before any await.
  try {
    if (
      typeof ClipboardItem !== "undefined" &&
      navigator.clipboard &&
      navigator.clipboard.write
    ) {
      // Create a promise that resolves to a Blob
      const textBlobPromise = urlPromise.then(
        (url) => new Blob([url], { type: "text/plain" })
      );
      // Pass the promise to ClipboardItem
      const item = new ClipboardItem({
        "text/plain": textBlobPromise,
      });
      await navigator.clipboard.write([item]);
      return await urlPromise; // Return URL so caller can show it/use it
    }
  } catch (err) {
    console.warn("ClipboardItem + Promise strategy failed, trying fallbacks...", err);
  }

  // Fallback: Wait for URL, then try standard writeText / execCommand
  // Note: This WILL fail on Safari if the network request took too long,
  // but it's the best we can do for older browsers.
  const url = await urlPromise;

  // Strategy 2: Standard writeText
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      return url;
    }
  } catch (err) {
    console.warn("navigator.clipboard.writeText failed, trying execCommand...", err);
  }

  // Strategy 3: Legacy execCommand
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

    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);

    if (successful) return url;
    else throw new Error("execCommand returned false");
  } catch (err) {
    // So we should throw here if we failed.
    throw new Error("Clipboard copy failed");
  }
}
