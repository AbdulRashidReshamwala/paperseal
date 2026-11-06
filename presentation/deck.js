const deck = document.getElementById('deck');
const slides = [...deck.querySelectorAll('.slide')];
const count = document.getElementById('count');
let i = Math.max(0, Math.min(slides.length - 1, (parseInt(location.hash.slice(1), 10) || 1) - 1));

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  deck.style.transform = `translate(-50%,-50%) scale(${s})`;
}
function show(n) {
  i = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((el, k) => el.classList.toggle('on', k === i));
  count.textContent = `${i + 1} / ${slides.length}`;
  history.replaceState(null, '', `#${i + 1}`);
}
addEventListener('resize', fit);
addEventListener('keydown', (e) => {
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) show(i + 1);
  if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) show(i - 1);
  if (e.key === 'Home') show(0);
  if (e.key === 'End') show(slides.length - 1);
});
deck.addEventListener('click', (e) => show(e.clientX < innerWidth / 3 ? i - 1 : i + 1));
fit();
show(i);
