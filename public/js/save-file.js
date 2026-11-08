/* حفظ ملف منزَّل: في تطبيق الأندرويد (Capacitor) يُكتب الملف ثم تُفتح قائمة المشاركة/الحفظ،
   وفي المتصفح العادي يُنزَّل مباشرة. */
window.saveBlob = async function (blob, name) {
  const C = window.Capacitor;
  const P = C && C.Plugins;
  if (C && C.isNativePlatform && C.isNativePlatform() && P && P.Filesystem && P.Share) {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    const w = await P.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
    await P.Share.share({ title: name, url: w.uri, dialogTitle: 'حفظ أو مشاركة الملف' });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
};
