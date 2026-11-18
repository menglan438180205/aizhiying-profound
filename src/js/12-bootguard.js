/*pfBootGuard*/(function(){setTimeout(function(){try{var b=document.getElementById("boot");if(!b){return;}var cs=window.getComputedStyle(b);if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity||"1")===0){return;}
/* 有凭证就绝不允许踢回登录页：直接把应用外壳显示出来（数据稍后自会补上） */
var hasTok=false;try{hasTok=!!(localStorage.getItem("pf.bff.token")||localStorage.getItem("pf.auth.token"));}catch(e){}
if(hasTok){try{b.style.display="none";var app=document.getElementById("app");if(app)app.style.display="flex";var lg=document.getElementById("loginView");if(lg)lg.classList.remove("show");}catch(e){}return;}
try{if(typeof window.showLogin==="function"){window.showLogin();}}catch(e){}setTimeout(function(){try{b.style.display="none";}catch(e){}},600);}catch(e){}},10000);})();