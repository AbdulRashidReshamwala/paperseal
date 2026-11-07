// Only one clip plays at a time.
const clips = [...document.querySelectorAll('video')];
for (const clip of clips) {
  clip.addEventListener('play', () => {
    for (const other of clips) if (other !== clip) other.pause();
  });
}

// The seal and stamps press down as they come into view. Without this script, or with reduced motion, they just show.
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!calm && 'IntersectionObserver' in window) {
  const stamps = document.querySelectorAll('.stamp, .packet-seal');
  const watch = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.replace('waiting', 'pressed');
        watch.unobserve(entry.target);
      }
    },
    { threshold: 0.8 },
  );
  for (const stamp of stamps) {
    stamp.classList.add('waiting');
    watch.observe(stamp);
  }
}
