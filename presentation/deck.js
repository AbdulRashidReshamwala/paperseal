const deck = document.getElementById('deck');
const slides = [...deck.querySelectorAll('.slide')];
const count = document.getElementById('count');
const bar = document.getElementById('bar');
let i = Math.max(0, Math.min(slides.length - 1, (parseInt(location.hash.slice(1), 10) || 1) - 1));

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  deck.style.transform = `translate(-50%,-50%) scale(${s})`;
}
function show(n, replay = false) {
  const next = Math.max(0, Math.min(slides.length - 1, n));
  if (next === i && !replay && slides[i].classList.contains('on')) return;
  i = next;
  slides.forEach((el) => el.classList.remove('on'));
  void deck.offsetWidth; // restart the animations
  slides[i].classList.add('on');
  count.textContent = `${i + 1} / ${slides.length}`;
  bar.style.width = `${((i + 1) / slides.length) * 100}%`;
  history.replaceState(null, '', `#${i + 1}`);
  rollDie();
}
// the seed dice tumbles through random faces, then lands on 5
let dieTimer;
function rollDie() {
  clearInterval(dieTimer);
  const use = slides[i].querySelector('#die use');
  if (!use || deck.classList.contains('static')) return;
  const start = performance.now() + 1500;
  dieTimer = setInterval(() => {
    const t = performance.now() - start;
    if (t < 0) return;
    if (t > 1250) { use.setAttribute('href', '#die-5'); clearInterval(dieTimer); return; }
    use.setAttribute('href', `#die-${1 + Math.floor(Math.random() * 6)}`);
  }, 90);
}
addEventListener('resize', fit);
addEventListener('keydown', (e) => {
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) show(i + 1);
  if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) show(i - 1);
  if (e.key === 'Home') show(0);
  if (e.key === 'End') show(slides.length - 1);
  if (e.key === 'r') show(i, true); // replay this slide's animation
  if (e.key === 'f') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
});
deck.addEventListener('click', (e) => show(e.clientX < innerWidth / 3 ? i - 1 : i + 1));
if (location.search.includes('static')) deck.classList.add('static'); // ?static shows every slide finished, no animation
fit();
show(i, true);
