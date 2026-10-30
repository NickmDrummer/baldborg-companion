import { useEffect, useRef } from "react";
import { createAvatar, type AvatarApi, type Mood } from "./createAvatar";

export default function Avatar({ mood }: { mood: Mood }) {
  const container = useRef<HTMLDivElement>(null);
  const avatar = useRef<AvatarApi | null>(null);

  useEffect(() => {
    if (!container.current) return;
    avatar.current = createAvatar(container.current);
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
