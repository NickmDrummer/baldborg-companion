import { useEffect, useRef } from "react";
import type { HeadMaterial } from "./bust";
import { createAvatar, type AvatarApi, type Mood } from "./createAvatar";

export default function Avatar({ mood, material }: { mood: Mood; material: HeadMaterial }) {
  const container = useRef<HTMLDivElement>(null);
  const avatar = useRef<AvatarApi | null>(null);

  useEffect(() => {
    if (!container.current) return;
    avatar.current = createAvatar(container.current, material);
    return () => {
      avatar.current?.dispose();
      avatar.current = null;
    };
  }, []);

  useEffect(() => {
    avatar.current?.setMood(mood);
  }, [mood]);

  return <div className="avatar" ref={container} />;
}
