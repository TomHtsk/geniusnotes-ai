// Light theme by default; only an explicit "dark" choice switches it. Loaded in <head>
// (external, so pages can use a strict Content-Security-Policy without inline scripts).
if(localStorage.getItem('gn-theme')!=='dark')document.documentElement.classList.add('light');