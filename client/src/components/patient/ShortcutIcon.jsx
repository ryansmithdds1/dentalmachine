import {
  Crown, Layers, CircleDot, CircleSlash, Scissors, Anchor, UserPlus, Waves, Shield, Sparkles, Star, Zap, Smile, Pill, Bone, Moon, Package, Plus, Check, Eye, Syringe, Hammer, Baby,
} from 'lucide-react';

// The icons a chart quick button can have (the same list as SHORTCUT_ICONS in server/src/chartengine.js).
export const ICONS = {
  crown: Crown, layers: Layers, 'circle-dot': CircleDot, 'circle-slash': CircleSlash, scissors: Scissors, anchor: Anchor, 'user-plus': UserPlus, waves: Waves,
  shield: Shield, sparkles: Sparkles, star: Star, zap: Zap, smile: Smile, pill: Pill, bone: Bone, moon: Moon, package: Package, plus: Plus, check: Check, eye: Eye,
  syringe: Syringe, hammer: Hammer, baby: Baby,
};

export default function ShortcutIcon({ name, size = 14 }) {
  const Icon = ICONS[name];
  return Icon ? <Icon size={size} aria-hidden /> : null;
}
