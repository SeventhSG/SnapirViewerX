/** English and Turkish strings. The team works in both. */

export type Lang = "en" | "tr";

const en = {
  /* shell */
  appName: "Snapir Viewer X",
  back: "Back",
  cancel: "Cancel",
  close: "Close",
  done: "Done",
  navHome: "Scans", navWork: "Workspace", navSettings: "Settings",

  /* home */
  heroLead: "Full-colour LiDAR scans from iPhone and iPad.",
  heroSub: "Open a scan, cut away what is not the room, measure what is.",
  openScan: "Open scan",
  openScanHint: "A .ply point cloud, or a .svxp project you saved earlier.",
  recent: "Recent",
  noScans: "No scans yet",
  noScansHelp:
    "Open a .ply exported from a scanning app on your iPhone or iPad. "
    + "Nothing is uploaded: the file is read on this machine and stays here.",
  points: "points", removed: "removed", measurements: "measurements",
  missing: "File not found", remove: "Remove from list",
  dropHere: "Drop a scan to open it",

  /* loading */
  reading: "Reading the file",
  parsing: "Reading points",
  opened: "Opened",
  openFailed: "That scan could not be opened",

  /* tools */
  toolOrbit: "Orbit", toolSelect: "Select", toolMeasure: "Measure",
  toolOrbitHint:
    "Drag to turn the scan. Middle button turns it in any tool, Ctrl with it "
    + "pans, wheel zooms.",
  toolSelectHint:
    "Drag a rectangle over the points to remove. Shift adds to the selection, "
    + "Alt takes away. Middle button turns the scan, Ctrl with it pans.",
  toolMeasureHint:
    "Click one point, then a second, to measure between them. Middle button "
    + "turns the scan.",

  /* where you are looking from */
  viewOutside: "Outside", viewInside: "Inside",
  insideHint:
    "W A S D to walk, Q and E to drop and rise. Drag with the middle button "
    + "to look around. Fit puts you back in the middle.",

  /* viewport actions */
  fit: "Fit", undo: "Undo", redo: "Redo",
  deleteSelected: "Delete", keepSelected: "Keep only these",
  clearSelection: "Clear selection", selectAll: "Select all",
  invertSelection: "Invert",
  restoreAll: "Restore everything",

  /* inspector */
  scan: "Scan", selection: "Selection", nothingSelected: "Nothing selected",
  sizeWDH: "Size", diagonal: "Diagonal", colour: "Colour",
  colourYes: "per point", colourNo: "none in the file",
  sourceFormat: "Format", readIn: "Read in",
  ofTotal: "of", history: "History", steps: "steps",
  noMeasurements: "No measurements yet",
  measureName: "Name", measureLength: "Length",
  deleteMeasurement: "Delete measurement",
  pickSecond: "Now pick the second point",

  /* export */
  export: "Export", exportProject: "Save project",
  exportProjectSub: "Everything, including the points you removed, so this can be reopened and changed.",
  exportPly: "Export cleaned .ply",
  exportPlySub: "Only the points that are left. For anything that reads point clouds.",
  exported: "Saved to", exportFailed: "Nothing was written",
  showInFolder: "Show in folder",

  /* settings */
  setUnits: "Units", setDisplay: "Appearance", setAbout: "About",
  displayUnit: "Measurement unit",
  displayUnitSub: "What lengths are shown in. Changes nothing in the scan.",
  sourceUnit: "This scan is measured in",
  sourceUnitSub:
    "A PLY file does not say what one unit means. Almost every iPhone and iPad "
    + "scanner writes metres. Set this wrong and every measurement is wrong by "
    + "the same factor.",
  defaultSourceUnit: "Assume new scans are in",
  defaultSourceUnitAuto: "Work it out from the size",
  theme: "Theme", themeLight: "Light", themeDark: "Dark",
  pointSize: "Point size",
  pointSizeSub: "Pixels. Larger closes the gaps on a sparse scan and costs frame rate.",
  attenuate: "Shrink distant points",
  attenuateSub: "Points take their size from distance, the way a photograph does.",
  upAxis: "Up axis", upAxisY: "Y up", upAxisZ: "Z up",
  upAxisSub:
    "Phone scanners write Y up. Scans that have been through survey software "
    + "are usually Z up.",
  language: "Language",
  version: "Version", renderer: "Renderer", about: "About",
  aboutBody:
    "Snapir Viewer X reads LiDAR scans on this machine. No scan, no measurement "
    + "and no part of any file leaves it.",

  /* toasts */
  nothingToDelete: "Nothing is selected",
  deletedN: "Removed", restoredN: "Restored", selectedN: "Selected",
  measurementAdded: "Measurement added",
  measurementRemoved: "Measurement removed",
  nothingUnder: "No point under the cursor",
  allGone: "That would remove every point",

  /* errors */
  crashTitle: "Snapir Viewer stopped",
  crashBody: "Something in the interface failed. The scan on disk is untouched.",
  reload: "Reload",
} as const;

export type Key = keyof typeof en;

const tr: Record<Key, string> = {
  appName: "Snapir Viewer X",
  back: "Geri",
  cancel: "Vazgeç",
  close: "Kapat",
  done: "Tamam",
  navHome: "Taramalar", navWork: "Çalışma alanı", navSettings: "Ayarlar",

  heroLead: "iPhone ve iPad'den tam renkli LiDAR taramaları.",
  heroSub: "Taramayı aç, odaya ait olmayanı kes, kalanı ölç.",
  openScan: "Tarama aç",
  openScanHint: "Bir .ply nokta bulutu veya daha önce kaydettiğin bir .svxp projesi.",
  recent: "Son kullanılanlar",
  noScans: "Henüz tarama yok",
  noScansHelp:
    "iPhone veya iPad'indeki tarama uygulamasından dışa aktardığın bir .ply aç. "
    + "Hiçbir şey yüklenmez: dosya bu makinede okunur ve burada kalır.",
  points: "nokta", removed: "silindi", measurements: "ölçüm",
  missing: "Dosya bulunamadı", remove: "Listeden çıkar",
  dropHere: "Açmak için bir tarama bırak",

  reading: "Dosya okunuyor",
  parsing: "Noktalar okunuyor",
  opened: "Açıldı",
  openFailed: "Bu tarama açılamadı",

  toolOrbit: "Döndür", toolSelect: "Seç", toolMeasure: "Ölç",
  toolOrbitHint:
    "Taramayı çevirmek için sürükle. Orta tuş her araçta çevirir, Ctrl ile "
    + "kaydırır, tekerlek yakınlaştırır.",
  toolSelectHint:
    "Silinecek noktaların üzerine bir dikdörtgen sürükle. Shift seçime ekler, "
    + "Alt çıkarır. Orta tuş taramayı çevirir, Ctrl ile kaydırır.",
  toolMeasureHint:
    "Bir noktaya, sonra ikinci bir noktaya tıkla. Orta tuş taramayı çevirir.",

  viewOutside: "Dışarıdan", viewInside: "İçeriden",
  insideHint:
    "Yürümek için W A S D, alçalıp yükselmek için Q ve E. Etrafa bakmak için "
    + "orta tuşla sürükle. Sığdır seni ortaya geri koyar.",

  fit: "Sığdır", undo: "Geri al", redo: "Yinele",
  deleteSelected: "Sil", keepSelected: "Yalnızca bunları tut",
  clearSelection: "Seçimi temizle", selectAll: "Tümünü seç",
  invertSelection: "Tersine çevir",
  restoreAll: "Hepsini geri getir",

  scan: "Tarama", selection: "Seçim", nothingSelected: "Seçim yok",
  sizeWDH: "Boyut", diagonal: "Köşegen", colour: "Renk",
  colourYes: "nokta başına", colourNo: "dosyada yok",
  sourceFormat: "Biçim", readIn: "Okuma süresi",
  ofTotal: "/", history: "Geçmiş", steps: "adım",
  noMeasurements: "Henüz ölçüm yok",
  measureName: "Ad", measureLength: "Uzunluk",
  deleteMeasurement: "Ölçümü sil",
  pickSecond: "Şimdi ikinci noktayı seç",

  export: "Dışa aktar", exportProject: "Projeyi kaydet",
  exportProjectSub: "Sildiğin noktalar dahil her şey. Tekrar açılıp değiştirilebilir.",
  exportPly: "Temizlenmiş .ply aktar",
  exportPlySub: "Yalnızca kalan noktalar. Nokta bulutu okuyan her şey için.",
  exported: "Kaydedildi", exportFailed: "Hiçbir şey yazılmadı",
  showInFolder: "Klasörde göster",

  setUnits: "Birimler", setDisplay: "Görünüm", setAbout: "Hakkında",
  displayUnit: "Ölçü birimi",
  displayUnitSub: "Uzunlukların gösterildiği birim. Taramada hiçbir şeyi değiştirmez.",
  sourceUnit: "Bu tarama şu birimde",
  sourceUnitSub:
    "Bir PLY dosyası bir biriminin ne anlama geldiğini söylemez. Neredeyse her "
    + "iPhone ve iPad tarayıcısı metre yazar. Bunu yanlış ayarlarsan her ölçüm "
    + "aynı katsayı kadar yanlış olur.",
  defaultSourceUnit: "Yeni taramaları şu birimde varsay",
  defaultSourceUnitAuto: "Boyutuna bakarak bul",
  theme: "Tema", themeLight: "Açık", themeDark: "Koyu",
  pointSize: "Nokta boyutu",
  pointSizeSub: "Piksel. Büyütmek seyrek taramadaki boşlukları kapatır, kare hızına mal olur.",
  attenuate: "Uzak noktaları küçült",
  attenuateSub: "Noktalar boyutunu mesafeden alır, fotoğraftaki gibi.",
  upAxis: "Yukarı ekseni", upAxisY: "Y yukarı", upAxisZ: "Z yukarı",
  upAxisSub:
    "Telefon tarayıcıları Y yukarı yazar. Ölçüm yazılımından geçmiş taramalar "
    + "genelde Z yukarıdır.",
  language: "Dil",
  version: "Sürüm", renderer: "Görüntüleyici", about: "Hakkında",
  aboutBody:
    "Snapir Viewer X LiDAR taramalarını bu makinede okur. Hiçbir tarama, ölçüm "
    + "veya dosya parçası buradan çıkmaz.",

  nothingToDelete: "Hiçbir şey seçili değil",
  deletedN: "Silindi", restoredN: "Geri getirildi", selectedN: "Seçildi",
  measurementAdded: "Ölçüm eklendi",
  measurementRemoved: "Ölçüm silindi",
  nothingUnder: "İmlecin altında nokta yok",
  allGone: "Bu, bütün noktaları silerdi",

  crashTitle: "Snapir Viewer durdu",
  crashBody: "Arayüzde bir şey başarısız oldu. Diskteki tarama değişmedi.",
  reload: "Yeniden yükle",
};

const TABLE: Record<Lang, Record<Key, string>> = { en, tr };

export function t(lang: Lang, key: Key): string {
  return TABLE[lang][key] ?? TABLE.en[key] ?? key;
}
