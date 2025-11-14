// src/components/SigningInOverlay.jsx
export default function SigningInOverlay({ label = "Loading…" }) {
  return (
    <div className="fixed inset-0 z-[120] bg-black/70 flex items-center justify-center">
      <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full bg-emerald-500 flex flex-col items-center justify-center shadow-2xl animate-pulse">
        <div className="text-gray-900 font-semibold text-xl sm:text-2xl select-none text-center px-4">
          {label}
        </div>
        <div className="flex gap-1 mt-1 text-gray-900 text-2xl leading-none select-none">
          <span className="animate-bounce [animation-delay:0ms]">•</span>
          <span className="animate-bounce [animation-delay:150ms]">•</span>
          <span className="animate-bounce [animation-delay:300ms]">•</span>
        </div>
      </div>
    </div>
  );
}
