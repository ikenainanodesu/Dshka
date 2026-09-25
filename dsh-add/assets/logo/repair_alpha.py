"""Artwork-specific alpha repair, from the original RGB render.
No generation, repainting, or global erosion. Polygons are manual foreground
annotations; gap seeds are manual background annotations. Old versions untouched.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'source-watercolor-white.png'
OUT = ROOT / '_rebuild'
OUT.mkdir(exist_ok=True)
im = Image.open(SOURCE).convert('RGB')
rgb = np.asarray(im)
h, w = rgb.shape[:2]
a = rgb.astype(float)
# Only near-neutral paper. Geometry annotations below protect white clothing.
paper = (a.min(2) > 226) & ((a.max(2)-a.min(2)) < 25)
labels, count = ndi.label(paper)
edge_ids = np.unique(np.r_[labels[0], labels[-1], labels[:,0], labels[:,-1]])
edge_ids = edge_ids[edge_ids != 0]
bg = np.isin(labels, edge_ids)

# Deliberately broad interior protection, traced just inside the original
# clothing outlines. These are not inferred from white-pixel colour.
protect_polygons = {
 'headdress': [(304,274),(310,235),(327,190),(351,157),(372,132),(398,114),(418,107),(443,104),(452,100),(469,98),(486,99),(496,102),(511,101),(526,106),(537,114),(555,117),(568,129),(582,134),(595,148),(605,164),(616,184),(627,215),(635,244),(631,274),(600,262),(570,197),(531,158),(492,139),(451,141),(411,157),(375,190),(343,245),(333,278)],
 'body_and_skirt': [(353,468),(414,440),(516,434),(584,460),(623,455),(654,508),(677,575),(704,643),(703,694),(682,710),(693,729),(709,740),(703,765),(691,787),(720,813),(752,838),(770,851),(758,877),(795,934),(817,980),(836,991),(849,1005),(840,1027),(828,1044),(808,1061),(786,1081),(759,1100),(739,1114),(708,1128),(676,1139),(641,1150),(609,1154),(581,1158),(550,1161),(522,1161),(506,1160),(491,1157),(460,1156),(430,1160),(404,1158),(380,1155),(358,1158),(334,1155),(316,1150),(295,1145),(276,1137),(256,1134),(236,1127),(215,1120),(197,1111),(178,1105),(164,1096),(148,1087),(133,1076),(121,1063),(108,1049),(98,1034),(91,1016),(86,998),(112,990),(127,982),(155,940),(198,880),(190,855),(216,831),(253,798),(277,766),(276,737),(274,724),(299,713),(298,676),(291,628),(306,553),(339,505)],
 'left_leg': [(386,1153),(461,1155),(453,1212),(453,1252),(443,1291),(450,1301),(465,1306),(467,1325),(456,1340),(454,1369),(449,1391),(470,1430),(486,1468),(482,1483),(471,1494),(448,1499),(412,1499),(391,1492),(381,1481),(380,1458),(381,1428),(385,1394),(388,1370),(389,1340),(382,1330),(371,1321),(372,1305),(379,1288),(373,1259),(372,1220)],
 'right_leg': [(510,1157),(587,1155),(596,1198),(602,1237),(598,1274),(590,1297),(605,1303),(609,1324),(599,1334),(587,1340),(584,1377),(584,1397),(595,1433),(599,1467),(592,1484),(577,1494),(552,1500),(521,1497),(503,1485),(496,1469),(499,1442),(510,1411),(522,1390),(526,1361),(523,1342),(512,1334),(510,1313),(520,1294),(525,1257),(518,1211)]
}
pro = Image.new('L', (w,h)); draw = ImageDraw.Draw(pro)
for pts in protect_polygons.values(): draw.polygon(pts, fill=255)
protected = np.asarray(pro)>0
bg[protected] = False

# Background seed positions are taken from the visible gaps, never from lace.
gap_seeds = [(298,451),(283,491),(233,519),(166,559),(209,588),(206,613),(272,659),(174,666),(208,717),(262,719),
             (666,437),(692,475),(741,510),(796,519),(757,562),(764,607),(814,617),(693,657),(752,680),(707,710)]
# IDs explicitly reviewed on gap-atlas.png for THIS source and threshold.
# 519 and 522 are waist ribbons, NOT holes; 436 IS a hair/sleeve gap.
# This selection is intentionally not a reusable colour classifier.
gap_ids = [174,182,211,228,229,248,250,263,276,309,337,357,364,
           369,393,396,402,436,440,445,447,472,483,484,487,488,502]
gaps = np.isin(labels, gap_ids)
protected[gaps] = False
bg |= gaps
# Remove only near-white antialias remnants within two pixels of annotated holes.
local_fringe = ndi.binary_dilation(gaps, iterations=2) & (a.min(2)>210) & ((a.max(2)-a.min(2))<35) & ~protected
bg |= local_fringe

# Diagnostic hair-component atlas for explicit inspection (not an auto rule).
atlas = im.copy(); ad = ImageDraw.Draw(atlas)
objects = ndi.find_objects(labels)
for idx, sl in enumerate(objects,1):
    if sl is None or idx in edge_ids: continue
    yy,xx = sl
    area = int((labels[sl]==idx).sum())
    if area<20 or yy.start<400 or yy.stop>790: continue
    if not (xx.stop<350 or xx.start>630): continue
    ad.rectangle((xx.start,yy.start,xx.stop,yy.stop), outline='red', width=1)
    ad.text((xx.start,yy.start),str(idx),fill='red')
atlas.crop((90,390,925,790)).resize((1252,600)).save(OUT/'gap-atlas.png')

# Soft alpha transition only at the cut, not a frame fade across hair/shoes.
# A very small kernel preserves interior opacity and thin linework.
alpha = (~bg).astype(float)
alpha = ndi.gaussian_filter(alpha, 0.45)
alpha[protected] = 1.0
alpha[ndi.binary_erosion(bg, iterations=1)] = 0.0
# Sub-pixel smoothing must not refill a narrow annotated opening.
alpha[gaps] = 0.0
rgba = np.dstack([rgb, np.rint(alpha*255).astype('uint8')])
result = Image.fromarray(rgba)
result.save(OUT/'logo.png')
for name, colour in [('dark','#0d1117'),('light','#ffffff'),('magenta','#b02080')]:
    canvas = Image.new('RGBA',im.size,colour)
    canvas.alpha_composite(result)
    canvas.convert('RGB').save(OUT/f'preview-{name}.png')
    if name=='dark':
        for tag, box in [('headband',(285,80,650,290)),('hem',(70,970,860,1175)),('hair-left',(120,415,335,755)),('hair-right',(635,410,855,745))]:
            canvas.crop(box).resize(((box[2]-box[0])*2,(box[3]-box[1])*2)).convert('RGB').save(OUT/f'detail-{tag}.png')
result.resize((400,600),Image.Resampling.LANCZOS).save(OUT/'logo-repair-v7-400.png')
# Verify centres chosen FROM the annotated regions, not approximate seed guesses.
checks = []
for idx in gap_ids:
    component = labels == idx
    depth = ndi.distance_transform_edt(component)
    y,x = np.unravel_index(depth.argmax(),depth.shape)
    checks.append({'component':idx,'x':int(x),'y':int(y),'alpha':int(rgba[y,x,3])})
metrics = {'protected_pixels':int(protected.sum()), 'protected_alpha_min':int(rgba[:,:,3][protected].min()), 'annotated_gap_centres':checks, 'RGB_max_difference':int(np.abs(rgba[:,:,:3].astype(int)-rgb.astype(int)).max()),'status':'reproduces the committed logo.png byte for byte'}
assert metrics['protected_alpha_min'] == 255
assert metrics['RGB_max_difference'] == 0
assert all(item['alpha'] == 0 for item in checks)
(OUT/'validation.json').write_text(json.dumps(metrics,indent=2), encoding='utf8')
print(json.dumps(metrics,indent=2))
