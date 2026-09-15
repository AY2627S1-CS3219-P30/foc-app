"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Screen } from "@/components/Screen";
import { useStore } from "@/lib/store";
import styles from "./page.module.css";

export default function LoginPage() {
  const { login } = useStore();
  const router = useRouter();

  function signIn() {
    login();
    router.push("/feed");
  }

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <div className={styles.wrap}>
            <div>
              <p className={styles.logo}>NUQueSt</p>
              <p className={styles.tagline}>Campus errands, run by students.</p>
            </div>
            <Button full onClick={signIn}>
              Sign in with Outlook
            </Button>
          </div>
        </Screen>
      </div>

      <div className="desktopOnly">
        <div className={styles.desktopPage}>
          <div className={styles.desktopCard}>
            <div>
              <p className={styles.desktopLogo}>NUQueSt</p>
              <p className={styles.desktopTagline}>Campus errands, run by students.</p>
            </div>
            <Button full onClick={signIn}>
              Sign in with Outlook
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
