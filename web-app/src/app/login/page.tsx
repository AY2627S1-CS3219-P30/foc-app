"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Screen } from "@/components/Screen";
import { useStore } from "@/lib/store";
import styles from "./page.module.css";

export default function LoginPage() {
  const { login } = useStore();
  const router = useRouter();

  return (
    <Screen>
      <div className={styles.wrap}>
        <div>
          <p className={styles.logo}>NUQueSt</p>
          <p className={styles.tagline}>Campus errands, run by students.</p>
        </div>
        <Button
          full
          onClick={() => {
            login();
            router.push("/feed");
          }}
        >
          Sign in with Outlook
        </Button>
      </div>
    </Screen>
  );
}
