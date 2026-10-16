let count = 0;
document.querySelector("#increment").addEventListener("click", () => {
  document.querySelector("#count").textContent = ++count;
  document.querySelector("#last-action").textContent = `Check ${count} completed at ${new Date().toLocaleTimeString()}.`;
});
document.querySelector("#theme").addEventListener("click", () => document.body.classList.toggle("demo-alternate"));
setInterval(() => { document.querySelector("#clock").textContent = new Date().toLocaleTimeString(); }, 1000);
