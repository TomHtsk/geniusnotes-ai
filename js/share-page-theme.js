// share.html: theme button (moved out of the page so share.html can forbid inline scripts).
// Theme button: same behaviour as the homepage and the Notepad (light unless "dark" was chosen).
function gnSyncThemeBtn(){var b=document.getElementById('gn-theme-btn');if(b)b.textContent=document.documentElement.classList.contains('light')?'Dark':'Light';}
function gnToggleTheme(){var l=document.documentElement.classList.toggle('light');localStorage.setItem('gn-theme',l?'light':'dark');gnSyncThemeBtn();}
window.addEventListener('storage',function(e){if(e.key==='gn-theme'){document.documentElement.classList.remove('light');gnSyncThemeBtn();}});
gnSyncThemeBtn();
