import NProgress from "@/config/nprogress";
import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [{ path: "/", name: "root", component: () => import("@/views/home.vue") }],
});

router.beforeEach(() => {
  NProgress.start();
});

router.afterEach(() => {
  NProgress.done();
});

router.onError((error) => {
  NProgress.done();
  console.warn("路由错误", error.message);
});

export default router;
