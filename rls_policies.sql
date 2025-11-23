-- Enable RLS on the table
ALTER TABLE public.quiz_share_answers ENABLE ROW LEVEL SECURITY;

-- Policy: Owners can view answers for attempts on their quizzes
CREATE POLICY "Owners can view answers"
ON public.quiz_share_answers
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.quiz_share_attempts a
    WHERE a.id = quiz_share_answers.attempt_id
      AND a.user_id = auth.uid()
  )
);

-- Policy: Service role can do anything (implicit, but good to know)
-- No INSERT policy needed for public if we use the Edge Function (Service Role)
