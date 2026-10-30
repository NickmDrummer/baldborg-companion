import { useEffect, useRef } from "react";
import { createAvatar } from "./createAvatar";

export default function Avatar() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const avatar = createAvatar(container.current);
    return () => avatar.dispose();
  }, []);

  return <div className="avatar" ref={container} />;
}
